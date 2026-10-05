import type { StoreDatabase } from "./store-database.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchiveUser } from "../domain/access.ts";
import { canEditArchive, isArchiveOwner } from "../domain/access.ts";
import { hasCurrentPlatformAdmin } from "./platform-access.ts";
import { memberPreviewTarget } from "./member-preview-access.ts";
import type { userStore } from "./users.ts";
import {
  newSessionToken,
  sessionTokenHash,
  validSessionToken,
  SESSION_MAX_AGE,
} from "./session-token.ts";
import { completePostgresOAuthLoginInTransaction } from "./postgres-yandex-login.ts";
import {
  issuePostgresEmailSessionInTransaction,
  issuePostgresSessionInTransaction,
} from "./postgres-sessions.ts";
export { SESSION_MAX_AGE } from "./session-token.ts";
const RENEW_INTERVAL = 24 * 60 * 60 * 1000;
const VISIT_INTERVAL = 60 * 1000;

export function accountProfileFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    fullAccess: row.full_access === true,
    provider:
      row.provider === "email"
        ? "email" as const
        : row.provider === "vk"
          ? "vk" as const
          : row.provider === "yandex"
            ? "yandex" as const
            : null,
    providers: Array.isArray(row.providers)
      ? row.providers.filter((value) =>
          ["email", "vk", "yandex"].includes(value),
        )
      : [],
  };
}
export async function createAuth(
  users: Awaited<ReturnType<typeof userStore>>,
  db: StoreDatabase,
  publicOrigin?: string,
) {
  const local = !publicOrigin,
    secure = publicOrigin?.startsWith("https://") ? "; Secure" : "";
  const removeExpired = db.prepare(
    "DELETE FROM auth_sessions WHERE expires_at <= ?",
    "DELETE FROM account_sessions WHERE expires_at <= ?",
  );
  await removeExpired.run(Date.now());
  const lookup = db.prepare(
    "SELECT user_id, expires_at FROM auth_sessions WHERE token_hash=?",
    "SELECT user_id, expires_at FROM account_sessions WHERE token_hash=?",
  );
  const revoke = db.prepare(
    "DELETE FROM auth_sessions WHERE token_hash=?",
    "DELETE FROM account_sessions WHERE token_hash=?",
  );
  const otherSessions = db.prepare(
    "SELECT count(*) AS count FROM auth_sessions WHERE user_id=? AND token_hash<>? AND expires_at>?",
    "SELECT count(*) AS count FROM account_sessions WHERE user_id=? AND token_hash<>? AND expires_at>?",
  );
  const revokeOthers = db.prepare(
    "DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?",
    "DELETE FROM account_sessions WHERE user_id=? AND token_hash<>?",
  );
  const revokeOthersWithCurrent =
    db.kind === "postgres"
      ? db.prepare(
          "",
          // The caller check and deletion share one statement snapshot. A
          // completed revoke between sessionFor() and this statement fails
          // closed, without cross-locking two simultaneous bulk revocations.
          `WITH current_session AS MATERIALIZED (
             SELECT 1 FROM account_sessions
              WHERE user_id=? AND token_hash=? AND expires_at>?
           ), revoked AS (
             DELETE FROM account_sessions
              WHERE user_id=? AND token_hash<>?
                AND EXISTS (SELECT 1 FROM current_session)
              RETURNING 1
           )
           SELECT (SELECT count(*) FROM current_session) AS active,
                  (SELECT count(*) FROM revoked) AS revoked`,
        )
      : null;
  const accountDetails =
    db.kind === "postgres"
      ? db.prepare(
          "",
          `SELECT a.id,a.name,a.created_at,a.last_visit_at,t.full_access,
                  (SELECT provider FROM account_identities i
                    WHERE i.account_id=a.id ORDER BY provider LIMIT 1) AS provider,
                  (SELECT array_agg(provider ORDER BY provider) FROM account_identities i
                    WHERE i.account_id=a.id) AS providers
             FROM accounts a LEFT JOIN account_tiers t ON t.account_id=a.id
            WHERE a.id=?`,
        )
      : null;
  const oauthProof =
    db.kind === "postgres"
      ? db.prepare(
          "",
          "SELECT authenticated_at FROM account_oauth_session_proofs WHERE token_hash=?",
        )
      : null;
  const globalVisit =
    db.kind === "postgres"
      ? db.prepare(
          "",
          "UPDATE accounts SET last_visit_at=? WHERE id=? AND (last_visit_at IS NULL OR last_visit_at<?)",
        )
      : null;
  const cookie = (req: IncomingMessage) =>
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("drevo_session="))
      ?.slice(14) || "";
  async function sessionFor(req: IncomingMessage) {
    const token = cookie(req);
    if (!validSessionToken(token)) return null;
    const tokenHash = sessionTokenHash(token);
    const row = await lookup.get(tokenHash);
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
      await revoke.run(tokenHash);
      return null;
    }
    return {
      token,
      tokenHash,
      userId: String(row.user_id),
      expires: Number(row.expires_at),
    };
  }
  function setCookie(
    res: ServerResponse,
    token: string,
    maxAge = SESSION_MAX_AGE,
  ) {
    const previous = res.getHeader("Set-Cookie");
    const cookies = previous
      ? Array.isArray(previous)
        ? previous
        : [String(previous)]
      : [];
    res.setHeader("Set-Cookie", [
      ...cookies,
      `drevo_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
    ]);
  }
  async function currentUser(
    req: IncomingMessage,
  ): Promise<ArchiveUser | null> {
    const localUser: ArchiveUser = {
        id: "local",
        name: "На этом компьютере",
        role: "admin",
        createdAt: "",
        approved: true,
      };
    const previewId = memberPreviewTarget(req);
    if (previewId) {
      const owner = local ? localUser :
        await (async () => {
          const session = await sessionFor(req);
          return session ? await users.get(session.userId) : null;
        })();
      if (!owner?.approved || !isArchiveOwner(owner)) return null;
      return await users.get(previewId);
    }
    if (local) return localUser;
    const session = await sessionFor(req);
    return session ? await users.get(session.userId) : null;
  }
  async function issueSession(
    req: IncomingMessage,
    res: ServerResponse,
    profile: { id: string; name: string },
  ) {
    const user = await users.register(profile.id, profile.name);
    await revoke.run(sessionTokenHash(cookie(req)));
    await removeExpired.run(Date.now());
    const token = newSessionToken();
    await db
      .prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      )
      .run(
        sessionTokenHash(token),
        user.id,
        Date.now() + SESSION_MAX_AGE * 1000,
      );
    await users.recordVisit(user.id);
    setCookie(res, token);
  }
  return {
    local,
    currentUser,
    async accountId(req: IncomingMessage) {
      if (local) return null;
      return (await sessionFor(req))?.userId || null;
    },
    async accountSession(req: IncomingMessage) {
      if (local) return null;
      const session = await sessionFor(req);
      return session
        ? { accountId: session.userId, tokenHash: session.tokenHash }
        : null;
    },
    async recentOAuthSession(req: IncomingMessage) {
      if (!oauthProof || local) return false;
      const session = await sessionFor(req);
      if (!session) return false;
      const proof = await oauthProof.get(session.tokenHash);
      const authenticatedAt = Number(proof?.authenticated_at);
      const elapsed = Date.now() - authenticatedAt;
      return (
        Number.isFinite(authenticatedAt) &&
        elapsed >= 0 &&
        elapsed <= 10 * 60 * 1000
      );
    },
    async accountProfile(req: IncomingMessage) {
      if (!accountDetails || local) return null;
      const session = await sessionFor(req);
      if (!session) return null;
      const row = await accountDetails.get(session.userId);
      return row ? accountProfileFromRow(row) : null;
    },
    issueSession,
    async issueAccountSession(
      req: IncomingMessage,
      res: ServerResponse,
      accountId: string,
      expectedPasswordHash?: string,
    ) {
      if (db.kind !== "postgres" || !db.postgresTransaction)
        throw new Error("Для входа по почте требуется PostgreSQL");
      const result = await db.postgresTransaction(async (client) => {
        return expectedPasswordHash
          ? issuePostgresEmailSessionInTransaction(
              client,
              accountId,
              expectedPasswordHash,
              cookie(req),
            )
          : issuePostgresSessionInTransaction(client, accountId, cookie(req));
      });
      setCookie(res, result.token);
    },
    async issueOAuthSession(
      req: IncomingMessage,
      res: ServerResponse,
      provider: "yandex" | "vk",
      profile: { id: string; name: string },
    ) {
      if (db.kind !== "postgres") {
        await issueSession(req, res, profile);
        return;
      }
      if (!db.postgresTransaction)
        throw new Error("Глобальная транзакция PostgreSQL недоступна");
      const result = await db.postgresTransaction(async (client) => {
        const login = await completePostgresOAuthLoginInTransaction(
          client,
          provider,
          profile,
          cookie(req),
        );
        await client.query(
          "INSERT INTO account_oauth_session_proofs(token_hash,provider,authenticated_at) VALUES($1,$2,$3)",
          [sessionTokenHash(login.session.token), provider, Date.now()],
        );
        return login;
      });
      setCookie(res, result.session.token);
      return `/a/${result.archiveId}/tree`;
    },
    async sessionSummary(req: IncomingMessage) {
      if (local) return { currentExpiresAt: null, otherCount: 0 };
      const session = await sessionFor(req);
      if (
        !session ||
        (db.kind !== "postgres" && !(await users.get(session.userId)))
      )
        return null;
      if (db.kind === "postgres" && db.postgresTransaction) {
        const now = Date.now();
        return db.postgresTransaction(async (client) => {
          const current = await client.query<{
            id: string;
            created_at: string | null;
            expires_at: string;
          }>(
            `SELECT public_id::text AS id,created_at,expires_at
               FROM account_sessions
              WHERE token_hash=$1 AND user_id=$2 AND expires_at>$3 FOR SHARE`,
            [session.tokenHash, session.userId, now],
          );
          if (
            !current.rows[0] ||
            Number(current.rows[0].expires_at) <= Date.now()
          )
            return null;
          const listedAt = Date.now();
          const others = await client.query<{
            id: string;
            created_at: string | null;
            expires_at: string;
          }>(
            `SELECT public_id::text AS id,created_at,expires_at
               FROM account_sessions
              WHERE user_id=$1 AND token_hash<>$2 AND expires_at>$3
              ORDER BY created_at DESC NULLS LAST,public_id LIMIT 20`,
            [session.userId, session.tokenHash, listedAt],
          );
          const total = await client.query<{ count: string }>(
            `SELECT count(*) AS count FROM account_sessions
              WHERE user_id=$1 AND token_hash<>$2 AND expires_at>$3`,
            [session.userId, session.tokenHash, listedAt],
          );
          const detail = (
            row: (typeof current.rows)[number],
            isCurrent: boolean,
          ) => ({
            id: row.id,
            isCurrent,
            createdAt:
              row.created_at === null
                ? null
                : new Date(Number(row.created_at)).toISOString(),
            expiresAt: new Date(Number(row.expires_at)).toISOString(),
          });
          return {
            currentExpiresAt: new Date(
              Number(current.rows[0].expires_at),
            ).toISOString(),
            otherCount: Number(total.rows[0].count),
            items: [
              detail(current.rows[0], true),
              ...others.rows.map((row) => detail(row, false)),
            ],
          };
        });
      }
      return {
        currentExpiresAt: new Date(session.expires).toISOString(),
        otherCount: Number(
          (
            await otherSessions.get(
              session.userId,
              session.tokenHash,
              Date.now(),
            )
          )?.count || 0,
        ),
      };
    },
    async revokeOtherSessions(req: IncomingMessage) {
      if (local) return 0;
      const session = await sessionFor(req);
      if (
        !session ||
        (db.kind !== "postgres" && !(await users.get(session.userId)))
      )
        return null;
      if (revokeOthersWithCurrent) {
        const result = await revokeOthersWithCurrent.get(
          session.userId,
          session.tokenHash,
          Date.now(),
          session.userId,
          session.tokenHash,
        );
        return Number(result?.active) === 1
          ? Number(result?.revoked || 0)
          : null;
      }
      return Number(
        (await revokeOthers.run(session.userId, session.tokenHash)).changes,
      );
    },
    async revokeManagedSession(req: IncomingMessage, id: string) {
      if (local || db.kind !== "postgres" || !db.postgresTransaction)
        return null;
      const session = await sessionFor(req);
      if (!session) return null;
      return db.postgresTransaction(async (client) => {
        const current = await client.query<{ id: string; expires_at: string }>(
          `SELECT public_id::text AS id,expires_at FROM account_sessions
            WHERE token_hash=$1 AND user_id=$2 AND expires_at>$3 FOR SHARE`,
          [session.tokenHash, session.userId, Date.now()],
        );
        if (
          !current.rows[0] ||
          Number(current.rows[0].expires_at) <= Date.now()
        )
          return null;
        if (current.rows[0].id === id) return "current" as const;
        const deleted = await client.query(
          `DELETE FROM account_sessions
            WHERE public_id=$1 AND user_id=$2 AND token_hash<>$3 AND expires_at>$4`,
          [id, session.userId, session.tokenHash, Date.now()],
        );
        return deleted.rowCount === 1;
      });
    },
    async refreshSession(req: IncomingMessage, res: ServerResponse) {
      if (local || req.headers["sec-fetch-site"] === "cross-site") return;
      const session = await sessionFor(req);
      if (!session) return;
      const user = await users.get(session.userId);
      if (!user && db.kind !== "postgres") return;
      const now = Date.now();
      // Persist authenticated activity at most once per minute per account.
      // Reading a user in the admin list must never count as their visit.
      if (
        !user?.lastVisitAt ||
        Date.parse(user.lastVisitAt) <= now - VISIT_INTERVAL
      )
        if (user) await users.recordVisit(user.id, now, VISIT_INTERVAL);
        else
          await globalVisit?.run(
            new Date(now).toISOString(),
            session.userId,
            new Date(now - VISIT_INTERVAL).toISOString(),
          );
      // Renew the session cookie at most once per day.
      if (
        session.expires >
        Date.now() + SESSION_MAX_AGE * 1000 - RENEW_INTERVAL
      )
        return;
      await db
        .prepare(
          "UPDATE auth_sessions SET expires_at=? WHERE token_hash=?",
          "UPDATE account_sessions SET expires_at=? WHERE token_hash=?",
        )
        .run(Date.now() + SESSION_MAX_AGE * 1000, session.tokenHash);
      setCookie(res, session.token);
    },
    privateArchive: process.env.ARCHIVE_PRIVATE === "1",
    canRead: async (req: IncomingMessage) =>
      (await currentUser(req))?.approved === true,
    canEdit: async (req: IncomingMessage) =>
      !memberPreviewTarget(req) && canEditArchive(await currentUser(req)),
    isAdmin: async (req: IncomingMessage) =>
      !memberPreviewTarget(req) && (await currentUser(req))?.approved === true &&
      isArchiveOwner(await currentUser(req)),
    isPlatformAdmin: async (req: IncomingMessage) => {
      if (memberPreviewTarget(req)) return false;
      if (local) return true;
      // SQLite remains a single-archive installation without platform grants.
      // Its approved owner retains the legacy administrator settings path.
      if (db.kind !== "postgres") {
        const actor = await currentUser(req);
        return actor?.approved === true && isArchiveOwner(actor);
      }
      const session = await sessionFor(req);
      return session
        ? await hasCurrentPlatformAdmin(db, session.userId, session.tokenHash)
        : false;
    },
    async logout(req: IncomingMessage, res: ServerResponse) {
      await revoke.run(sessionTokenHash(cookie(req)));
      setCookie(res, "", 0);
    },
    clearSessionCookie(res: ServerResponse) {
      setCookie(res, "", 0);
    },
  };
}
