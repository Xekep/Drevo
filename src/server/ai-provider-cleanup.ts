import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StoreDatabase } from "./store-database.ts";
import { YandexResponseError, yandexResponsesClient } from "./yandex-responses.ts";

type Credential = { conversationId: string; baseUrl: string; folderId: string; apiKey: string };
type InputFileCredential = { fileId: string; baseUrl: string; folderId: string; apiKey: string };
type Runtime = Pick<Credential, "baseUrl" | "folderId" | "apiKey">;
type Claimed = { id: string; encrypted_snapshot: string; lease_token: string; attempts: number };

const keyName = "ai-provider-cleanup.v1.key";
const fingerprint = (key: Buffer) => createHash("sha256").update(key).digest("hex");

async function secureFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0))
    throw new Error("AI cleanup key is not a private regular file");
}

async function writeNew(path: string, content: Buffer) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    // Publish fully written bytes without replacing a concurrent process's key.
    await link(temporary, path);
    if (process.platform !== "win32") {
      const parent = await open(dirname(path), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Both paths derive only from the explicitly configured platform database path. */
export function providerCleanupKeyPaths(configuredPath: string) {
  const platformRoot = resolve(dirname(configuredPath));
  return {
    primary: join(platformRoot, keyName),
    backup: join(platformRoot, "backups", "platform-keys", keyName),
  };
}

async function loadKey(db: StoreDatabase, configuredPath: string) {
  const paths = providerCleanupKeyPaths(configuredPath);
  const existing = await db.prepare(
    "SELECT fingerprint FROM platform_ai_cleanup_keys WHERE version=1",
    "SELECT fingerprint FROM platform_ai_cleanup_keys WHERE version=1",
  ).get();
  const count = await db.prepare(
    "SELECT 1 AS present FROM platform_ai_conversations LIMIT 1",
    "SELECT 1 AS present FROM platform_ai_conversations UNION ALL SELECT 1 FROM platform_ai_input_files LIMIT 1",
  ).get();
  await mkdir(dirname(paths.primary), { recursive: true, mode: 0o700 });
  let primary: Buffer;
  try {
    primary = await readFile(paths.primary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing || count)
      throw new Error("AI cleanup key is missing");
    const created = Buffer.from(JSON.stringify({ version: 1, key: randomBytes(32).toString("base64") }));
    try { await writeNew(paths.primary, created); } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
    }
    primary = await readFile(paths.primary);
  }
  await secureFile(paths.primary);
  let decoded: { version?: number; key?: string };
  try { decoded = JSON.parse(primary.toString("utf8")); }
  catch { throw new Error("AI cleanup key is invalid"); }
  const key = Buffer.from(decoded.key || "", "base64");
  if (decoded.version !== 1 || key.length !== 32)
    throw new Error("AI cleanup key is invalid");
  const digest = fingerprint(key);
  if (existing && existing.fingerprint !== digest)
    throw new Error("AI cleanup key does not match the database");
  await mkdir(dirname(paths.backup), { recursive: true, mode: 0o700 });
  try {
    const saved = await readFile(paths.backup);
    await secureFile(paths.backup);
    if (!saved.equals(primary)) throw new Error("AI cleanup backup key does not match");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing || count)
      throw error;
    try { await writeNew(paths.backup, primary); } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
    }
    await secureFile(paths.backup);
    if (!(await readFile(paths.backup)).equals(primary))
      throw new Error("AI cleanup backup key does not match");
  }
  await db.prepare(
    "INSERT OR IGNORE INTO platform_ai_cleanup_keys(version,fingerprint) VALUES(1,?)",
    "INSERT INTO platform_ai_cleanup_keys(version,fingerprint) VALUES(1,?) ON CONFLICT(version) DO NOTHING",
  ).run(digest);
  const stored = await db.prepare(
    "SELECT fingerprint FROM platform_ai_cleanup_keys WHERE version=1",
    "SELECT fingerprint FROM platform_ai_cleanup_keys WHERE version=1",
  ).get();
  if (stored?.fingerprint !== digest) throw new Error("AI cleanup key does not match the database");
  return key;
}

function encrypt(key: Buffer, value: Credential | InputFileCredential) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}
function decryptJson(key: Buffer, value: string): Record<string, unknown> {
  const parts = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16)
    throw new Error("AI cleanup snapshot is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, parts[0]);
  decipher.setAuthTag(parts[1]);
  const result = JSON.parse(Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8"));
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("AI cleanup snapshot is invalid");
  return result;
}
function decrypt(key: Buffer, value: string): Credential {
  const result = decryptJson(key, value);
  if (!result || typeof result.conversationId !== "string" ||
      typeof result.baseUrl !== "string" || typeof result.folderId !== "string" ||
      typeof result.apiKey !== "string") throw new Error("AI cleanup snapshot is invalid");
  return result as Credential;
}
function decryptInputFile(key: Buffer, value: string): InputFileCredential {
  const result = decryptJson(key, value);
  if (!result || typeof result.fileId !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(result.fileId) ||
      typeof result.baseUrl !== "string" || typeof result.folderId !== "string" ||
      typeof result.apiKey !== "string") throw new Error("AI input file snapshot is invalid");
  return result as InputFileCredential;
}

export async function aiProviderCleanup(db: StoreDatabase, configuredPath: string, fetcher: typeof fetch = fetch) {
  const key = await loadKey(db, configuredPath);
  const assertReady = async () => {
    if (!(await loadKey(db, configuredPath)).equals(key))
      throw new Error("AI cleanup key changed while server was running");
  };
  const responses = yandexResponsesClient(fetcher);
  const archiveId = db.archiveId || "local";
  const pending = (ref: string) => db.prepare(
    "UPDATE platform_ai_conversations SET state='pending',available_at=?,updated_at=? WHERE id=? AND state IN ('binding','active')",
    "UPDATE platform_ai_conversations SET state='pending',available_at=?,updated_at=? WHERE id=? AND state IN ('binding','active')",
  ).run(Date.now(), Date.now(), ref);
  return {
    assertReady,
    /** Register every known input ID before the provider can use it. The
     * binding deadline recovers a process killed before its finally block. */
    async registerInputFile(fileId: string, runtime: Runtime, bindingUntil: number) {
      if (db.kind !== "postgres") throw new Error("Durable input file cleanup needs PostgreSQL");
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(fileId) ||
          !Number.isSafeInteger(bindingUntil))
        throw new Error("Invalid AI input file registration");
      await assertReady();
      const id = randomUUID(), now = Date.now();
      await db.prepare("", `INSERT INTO public.platform_ai_input_files
        (id,key_version,encrypted_snapshot,state,available_at,created_at,updated_at)
        VALUES(?,1,?,'binding',?,?,?)`).run(id,
        encrypt(key, { fileId, baseUrl: runtime.baseUrl,
          folderId: runtime.folderId, apiKey: runtime.apiKey }),
        Math.max(bindingUntil, now + 5_001), now, now);
      return id;
    },
    async queueInputFile(id: string) {
      const now = Date.now();
      await db.prepare("", `UPDATE public.platform_ai_input_files
        SET state='pending',available_at=?,updated_at=?
        WHERE id=? AND state='binding'`).run(now, now, id);
    },
    async compensateInputFile(fileId: string, runtime: Runtime) {
      try {
        await responses.deleteCalculationFile(runtime, fileId, AbortSignal.timeout(5000));
      } catch (error) {
        if (!(error instanceof YandexResponseError && error.status === 404))
          console.warn(JSON.stringify({ event: "ai.input_file_compensation_failed" }));
      }
    },
    async processInputFiles(limit = 2) {
      if (db.kind !== "postgres" || !db.postgresTransaction) return 0;
      await assertReady();
      let processed = 0;
      for (let index = 0; index < Math.min(Math.max(limit, 1), 8); index++) {
        const now = Date.now(), token = randomUUID();
        const [job] = await db.postgresTransaction(async (client) => {
          const rows = await client.query<Claimed>(`WITH due AS (
            SELECT id FROM public.platform_ai_input_files
            WHERE (state='pending' AND available_at<=$1)
               OR (state IN ('binding','leased') AND coalesce(lease_until,available_at)<=$1)
            ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
          ) UPDATE public.platform_ai_input_files work SET state='leased',
            lease_token=$2,lease_until=$3,attempts=attempts+1,updated_at=$1
            FROM due WHERE work.id=due.id
            RETURNING work.id,work.encrypted_snapshot,work.lease_token,work.attempts`,
          [now, token, now + 120_000]);
          return rows.rows;
        });
        if (!job) break;
        processed++;
        let state = "done", category: string | null = null;
        let snapshot: InputFileCredential | null = null;
        try { snapshot = decryptInputFile(key, job.encrypted_snapshot); }
        catch { state = "blocked"; category = "snapshot_invalid"; }
        if (snapshot) {
          try {
            await responses.deleteCalculationFile(snapshot, snapshot.fileId,
              AbortSignal.timeout(90_000));
          } catch (error) {
            const status = error instanceof YandexResponseError ? error.status : 0;
            if (status === 404) state = "done";
            else if (status === 401 || status === 403) {
              state = "blocked"; category = `provider_auth_${status}`;
            } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
              state = "blocked"; category = `provider_rejected_${status}`;
            } else {
              state = "pending";
              category = status ? `provider_http_${status}` : "provider_network";
            }
          }
        }
        const savedAt = Date.now();
        const delay = state === "pending" ? Math.min(24 * 60 * 60_000,
          30_000 * 2 ** Math.min(job.attempts - 1, 11)) : 0;
        const saved = await db.prepare("", `UPDATE public.platform_ai_input_files
          SET state=?,available_at=?,lease_token=NULL,lease_until=NULL,
              last_error=?,updated_at=?,
              encrypted_snapshot=CASE WHEN ?='done' THEN NULL ELSE encrypted_snapshot END
          WHERE id=? AND lease_token=?`).run(state, savedAt + delay, category,
            savedAt, state, job.id, job.lease_token);
        if (saved.changes) console.info(JSON.stringify({
          event: "ai.input_file_cleanup_attempt", jobId: job.id,
        }));
      }
      return processed;
    },
    async compensateKnown(chatId: string, conversationId: string, runtime: Runtime) {
      try {
        await responses.deleteConversation(runtime, conversationId);
      } catch (error) {
        if (!(error instanceof YandexResponseError && error.status === 404))
          console.warn(JSON.stringify({ event: "ai.provider_compensation_failed",
            localConversationId: chatId,
            status: error instanceof YandexResponseError ? error.status : undefined }));
      }
    },
    /** Durable before binding. An interrupted or stale bind remains recoverable. */
    async register(chatId: string, conversationId: string, runtime: Runtime,
      bindingMs = 60_000) {
      await assertReady();
      const id = randomUUID(), now = Date.now();
      await db.prepare(
        `INSERT INTO platform_ai_conversations
         (id,key_version,encrypted_snapshot,archive_id,local_chat_id,state,available_at,created_at,updated_at)
         VALUES(?,?,?,?,?,'binding',?,?,?)`,
        `INSERT INTO platform_ai_conversations
         (id,key_version,encrypted_snapshot,archive_id,local_chat_id,state,available_at,created_at,updated_at)
         VALUES(?,?,?,?,?,'binding',?,?,?)`,
      ).run(id, 1, encrypt(key, { conversationId, baseUrl: runtime.baseUrl,
        folderId: runtime.folderId, apiKey: runtime.apiKey }), archiveId, chatId,
        now + bindingMs, now, now);
      return id;
    },
    /** A connection-check conversation has no chat row. Its bounded binding
     * expires after the entire HTTP test deadline if the process exits. */
    async registerTest(conversationId: string, runtime: Runtime) {
      const localId = `admin-test:${randomUUID()}`;
      try {
        return await this.register(localId, conversationId, runtime, 300_000);
      } catch (error) {
        await this.compensateKnown(localId, conversationId, runtime);
        throw error;
      }
    },
    pending,
    async claim(limit = 4): Promise<Claimed[]> {
      const now = Date.now(), token = randomUUID();
      if (db.kind === "postgres" && db.postgresTransaction) {
        return await db.postgresTransaction(async (client) => {
          const rows = await client.query<Claimed>(`WITH due AS (
            SELECT id FROM platform_ai_conversations
            WHERE (state='pending' AND available_at<=$1)
               OR (state IN ('binding','leased') AND coalesce(lease_until,available_at)<=$1)
            ORDER BY available_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
          ) UPDATE platform_ai_conversations work SET state='leased',
            lease_token=$3,lease_until=$4,attempts=attempts+1,updated_at=$1
            FROM due WHERE work.id=due.id
            RETURNING work.id,work.encrypted_snapshot,work.lease_token,work.attempts`,
          [now, Math.min(Math.max(limit, 1), 8), token, now + 120_000]);
          return rows.rows;
        });
      }
      return await db.transaction(async () => {
        const rows = await db.prepare(
          `SELECT id,encrypted_snapshot,attempts FROM platform_ai_conversations
           WHERE (state='pending' AND available_at<=?) OR
             (state IN ('binding','leased') AND coalesce(lease_until,available_at)<=?)
           ORDER BY available_at,id LIMIT ?`,
          "",
        ).all(now, now, Math.min(Math.max(limit, 1), 8));
        for (const row of rows) await db.prepare(
          "UPDATE platform_ai_conversations SET state='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",
          "",
        ).run(token, now + 120_000, String(row.id));
        return rows.map((row) => ({ id: String(row.id), encrypted_snapshot: String(row.encrypted_snapshot),
          lease_token: token, attempts: Number(row.attempts) + 1 }));
      });
    },
    async process(limit = 4) {
      await assertReady();
      let processed = 0;
      // Claim immediately before each <=90s HTTP call. A batch-wide 120s
      // lease would expire before the last sequential request starts.
      for (let index = 0; index < Math.min(Math.max(limit, 1), 8); index++) {
        const [job] = await this.claim(1);
        if (!job) break;
        processed++;
        let state = "done", category: string | null = null;
        let snapshot: Credential | null = null;
        try {
          snapshot = decrypt(key, job.encrypted_snapshot);
        } catch {
          state = "blocked"; category = "snapshot_invalid";
        }
        if (snapshot) {
          try {
            await responses.deleteConversation(snapshot, snapshot.conversationId);
          } catch (error) {
            const status = error instanceof YandexResponseError ? error.status : 0;
            if (status === 404) state = "done";
            else if (status === 401 || status === 403) {
              state = "blocked"; category = `provider_auth_${status}`;
            } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
              state = "blocked"; category = `provider_rejected_${status}`;
            } else {
              state = "pending";
              category = status ? `provider_http_${status}` : "provider_network";
            }
          }
        }
        const now = Date.now();
        const delay = state === "pending" ? Math.min(24 * 60 * 60_000,
          30_000 * 2 ** Math.min(job.attempts - 1, 11)) : 0;
        const saved = await db.prepare(
          `UPDATE platform_ai_conversations SET state=?,available_at=?,lease_token=NULL,
           lease_until=NULL,last_error=?,updated_at=?,encrypted_snapshot=CASE WHEN ?='done' THEN NULL ELSE encrypted_snapshot END
           WHERE id=? AND lease_token=?`,
          `UPDATE platform_ai_conversations SET state=?,available_at=?,lease_token=NULL,
           lease_until=NULL,last_error=?,updated_at=?,encrypted_snapshot=CASE WHEN ?='done' THEN NULL ELSE encrypted_snapshot END
           WHERE id=? AND lease_token=?`,
        ).run(state, now + delay, category, now, state, job.id, job.lease_token);
        if (saved.changes)
          console.info(JSON.stringify({ event: "ai.provider_cleanup_attempt",
            jobId: job.id, state, category }));
      }
      return processed;
    },
  };
}

export type AiProviderCleanup = Awaited<ReturnType<typeof aiProviderCleanup>>;
