import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  randomUUID,
} from "node:crypto";
import type pg from "pg";
import type { StoreDatabase } from "./store-database.ts";
import { ARCHIVE_SCHEMA_VERSION } from "./schema.ts";
import { provisionPrivateArchiveInTransaction } from "./postgres-private-archive.ts";

const PASSWORD_COST = { N: 1 << 14, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
const scrypt = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, 32, PASSWORD_COST, (error, derived) =>
      error ? reject(error) : resolve(derived as Buffer),
    ),
  );
const REGISTER_LIFETIME = 24 * 60 * 60 * 1000;
const RESET_LIFETIME = 30 * 60 * 1000;
const EMAIL_COOLDOWN = 60 * 1000;
const DUMMY_HASH =
  "scrypt$16384$8$5$2d14a31d02ff2175bd89d20f1a7081df$167103d9acb595920576aac1782847df92ab983d0590747beea356a52dcb8779";

export class InvalidEmailCredential extends Error {}

export function normalizeAccountEmail(value: unknown) {
  if (typeof value !== "string")
    throw new InvalidEmailCredential("Некорректный адрес почты.");
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(
      email,
    ) ||
    email.includes("..")
  )
    throw new InvalidEmailCredential("Некорректный адрес почты.");
  return email;
}

export function validateAccountPassword(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    Buffer.byteLength(value, "utf8") > 1024
  )
    throw new InvalidEmailCredential(
      "Пароль должен содержать не менее 12 символов.",
    );
  return value;
}

export async function hashAccountPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${PASSWORD_COST.N}$${PASSWORD_COST.r}$${PASSWORD_COST.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyAccountPassword(password: string, stored: string) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (
    n !== PASSWORD_COST.N ||
    r !== PASSWORD_COST.r ||
    p !== PASSWORD_COST.p ||
    !/^[0-9a-f]{32}$/.test(parts[4]) ||
    !/^[0-9a-f]{64}$/.test(parts[5])
  )
    return false;
  const actual = await scrypt(password, Buffer.from(parts[4], "hex"));
  return timingSafeEqual(actual, Buffer.from(parts[5], "hex"));
}

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const validToken = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);

export function emailCredentials(
  db: StoreDatabase,
  send: (to: string, subject: string, text: string) => Promise<void>,
  origin: string,
  now = Date.now,
) {
  if (!db.postgresTransaction)
    throw new Error("Регистрация по почте требует PostgreSQL.");
  const transact = db.postgresTransaction;

  async function cleanup(client: pg.PoolClient, time: number) {
    await client.query(
      `DELETE FROM pending_email_registrations WHERE ctid IN
        (SELECT ctid FROM pending_email_registrations WHERE expires_at<=$1
          ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`,
      [time],
    );
    await client.query(
      `DELETE FROM email_password_resets WHERE ctid IN
        (SELECT ctid FROM email_password_resets WHERE expires_at<=$1
          ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`,
      [time],
    );
    await client.query(
      `DELETE FROM pending_email_links WHERE ctid IN
        (SELECT ctid FROM pending_email_links WHERE expires_at<=$1
          ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`,
      [time],
    );
  }

  return {
    async requestRegistration(input: {
      email: unknown;
      name: unknown;
      password: unknown;
    }) {
      const email = normalizeAccountEmail(input.email);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 160)
        throw new InvalidEmailCredential("Укажите имя до 160 символов.");
      const password = validateAccountPassword(input.password);
      const hash = await hashAccountPassword(password);
      const token = newToken();
      const time = now();
      await transact((client) => cleanup(client, time));
      const queued = await transact(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(2407,hashtext($1))", [
          email,
        ]);
        const exists = await client.query(
          "SELECT 1 FROM account_email_credentials WHERE email=$1",
          [email],
        );
        if (exists.rowCount) return false;
        const pending = await client.query<{ sent_at: string }>(
          "SELECT sent_at FROM pending_email_registrations WHERE email=$1 FOR UPDATE",
          [email],
        );
        if (
          pending.rows[0] &&
          Number(pending.rows[0].sent_at) > time - EMAIL_COOLDOWN
        )
          return false;
        await client.query(
          `INSERT INTO pending_email_registrations(email,name,password_hash,token_hash,expires_at,sent_at)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(email) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,
             token_hash=excluded.token_hash,expires_at=excluded.expires_at,sent_at=excluded.sent_at`,
          [email, name, hash, tokenHash(token), time + REGISTER_LIFETIME, time],
        );
        return true;
      });
      if (queued) {
        try {
          await send(
            email,
            "Подтвердите почту Drevo",
            `Чтобы создать личное древо, откройте ссылку:\n${origin}/account#email-verify=${token}\n\nСсылка действует 24 часа. Если это были не вы, проигнорируйте письмо.`,
          );
        } catch {
          await transact((client) =>
            client.query(
              "DELETE FROM pending_email_registrations WHERE email=$1 AND token_hash=$2",
              [email, tokenHash(token)],
            ),
          );
          throw new Error("Не удалось отправить письмо. Попробуйте позднее.");
        }
      }
    },

    async verifyRegistration(token: unknown) {
      if (!validToken(token))
        throw new InvalidEmailCredential(
          "Ссылка подтверждения недействительна.",
        );
      const time = now();
      return await transact(async (client) => {
        const found = await client.query<{ email: string }>(
          "SELECT email FROM pending_email_registrations WHERE token_hash=$1",
          [tokenHash(token)],
        );
        if (!found.rows[0])
          throw new InvalidEmailCredential("Ссылка подтверждения устарела.");
        await client.query("SELECT pg_advisory_xact_lock(2407,hashtext($1))", [
          found.rows[0].email,
        ]);
        const pending = await client.query<{
          email: string;
          name: string;
          password_hash: string;
          expires_at: string;
        }>(
          "SELECT email,name,password_hash,expires_at FROM pending_email_registrations WHERE token_hash=$1 FOR UPDATE",
          [tokenHash(token)],
        );
        const row = pending.rows[0];
        if (!row || Number(row.expires_at) <= time)
          throw new InvalidEmailCredential("Ссылка подтверждения устарела.");
        if (
          (
            await client.query(
              "SELECT 1 FROM account_email_credentials WHERE email=$1",
              [row.email],
            )
          ).rowCount
        )
          throw new InvalidEmailCredential("Этот адрес уже зарегистрирован.");
        const accountId = randomUUID();
        const archiveId = randomUUID();
        await client.query(
          "INSERT INTO accounts(id,name,created_at) VALUES($1,$2,$3)",
          [accountId, row.name, new Date(time).toISOString()],
        );
        await client.query("INSERT INTO account_tiers(account_id) VALUES($1)", [
          accountId,
        ]);
        await client.query(
          "INSERT INTO account_identities(provider,subject,account_id) VALUES('email',$1,$2)",
          [row.email, accountId],
        );
        await client.query(
          "INSERT INTO account_email_credentials(account_id,email,password_hash) VALUES($1,$2,$3)",
          [accountId, row.email, row.password_hash],
        );
        await client.query("SELECT set_config('drevo.account_id',$1,true)", [
          accountId,
        ]);
        await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
          archiveId,
        ]);
        await provisionPrivateArchiveInTransaction(
          client,
          accountId,
          archiveId,
          "Моё древо",
          ARCHIVE_SCHEMA_VERSION,
        );
        await client.query(
          "DELETE FROM pending_email_registrations WHERE email=$1",
          [row.email],
        );
        return { accountId, archiveId };
      });
    },

    async login(input: { email: unknown; password: unknown }) {
      const email = normalizeAccountEmail(input.email);
      const password = typeof input.password === "string" ? input.password : "";
      if (!password || Buffer.byteLength(password, "utf8") > 1024)
        throw new InvalidEmailCredential("Неверная почта или пароль.");
      const row = await transact(
        async (client) =>
          (
            await client.query<{
              account_id: string;
              password_hash: string;
            }>(
              `SELECT account_id,password_hash FROM account_email_credentials WHERE email=$1`,
              [email],
            )
          ).rows[0],
      );
      const valid = await verifyAccountPassword(
        password,
        row?.password_hash || DUMMY_HASH,
      );
      if (!row || !valid)
        throw new InvalidEmailCredential("Неверная почта или пароль.");
      const archiveId = await transact(async (client) => {
        await client.query("SELECT set_config('drevo.account_id',$1,true)", [
          row.account_id,
        ]);
        return (
          await client.query<{ archive_id: string }>(
            `SELECT m.archive_id FROM archive_memberships m
               JOIN archives a ON a.id=m.archive_id
               LEFT JOIN archive_owners o
                 ON o.archive_id=m.archive_id AND o.user_id=m.user_id
              WHERE m.user_id=$1 AND m.approved
              ORDER BY (o.user_id IS NOT NULL) DESC,lower(a.title),a.id
              LIMIT 1`,
            [row.account_id],
          )
        ).rows[0]?.archive_id;
      });
      // A reset can commit between checking the password and issuing a session.
      // The session issuer rechecks this hash under the credential row lock.
      return {
        accountId: row.account_id,
        archiveId: archiveId ?? null,
        passwordHash: row.password_hash,
      };
    },

    async requestReset(value: unknown) {
      const email = normalizeAccountEmail(value);
      const token = newToken();
      const time = now();
      await transact((client) => cleanup(client, time));
      const queued = await transact(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(2407,hashtext($1))", [
          email,
        ]);
        if (
          !(
            await client.query(
              "SELECT 1 FROM account_email_credentials WHERE email=$1",
              [email],
            )
          ).rowCount
        )
          return false;
        const existing = await client.query<{ sent_at: string }>(
          "SELECT sent_at FROM email_password_resets WHERE email=$1 FOR UPDATE",
          [email],
        );
        if (
          existing.rows[0] &&
          Number(existing.rows[0].sent_at) > time - EMAIL_COOLDOWN
        )
          return false;
        await client.query(
          `INSERT INTO email_password_resets(email,token_hash,expires_at,sent_at) VALUES($1,$2,$3,$4)
           ON CONFLICT(email) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,sent_at=excluded.sent_at`,
          [email, tokenHash(token), time + RESET_LIFETIME, time],
        );
        return true;
      });
      if (queued) {
        try {
          await send(
            email,
            "Восстановление доступа Drevo",
            `Чтобы задать новый пароль, откройте ссылку:\n${origin}/account#email-reset=${token}\n\nСсылка действует 30 минут. Если это были не вы, проигнорируйте письмо.`,
          );
        } catch {
          await transact((client) =>
            client.query(
              "DELETE FROM email_password_resets WHERE email=$1 AND token_hash=$2",
              [email, tokenHash(token)],
            ),
          );
          throw new Error("Не удалось отправить письмо. Попробуйте позднее.");
        }
      }
    },

    async requestLink(
      accountId: string,
      input: { email: unknown; password: unknown },
    ) {
      const email = normalizeAccountEmail(input.email);
      const password = validateAccountPassword(input.password);
      const hash = await hashAccountPassword(password);
      const token = newToken();
      const time = now();
      await transact((client) => cleanup(client, time));
      const queued = await transact(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(2407,hashtext($1))", [
          email,
        ]);
        if (
          !(
            await client.query("SELECT 1 FROM accounts WHERE id=$1", [
              accountId,
            ])
          ).rowCount
        )
          throw new InvalidEmailCredential("Аккаунт недоступен.");
        if (
          (
            await client.query(
              "SELECT 1 FROM account_email_credentials WHERE account_id=$1",
              [accountId],
            )
          ).rowCount
        )
          throw new InvalidEmailCredential("Почта уже привязана к аккаунту.");
        if (
          (
            await client.query(
              "SELECT 1 FROM account_email_credentials WHERE email=$1",
              [email],
            )
          ).rowCount ||
          (
            await client.query(
              "SELECT 1 FROM pending_email_links WHERE email=$1 AND account_id<>$2",
              [email, accountId],
            )
          ).rowCount
        )
          return false;
        const pending = await client.query<{ sent_at: string }>(
          "SELECT sent_at FROM pending_email_links WHERE account_id=$1 FOR UPDATE",
          [accountId],
        );
        if (
          pending.rows[0] &&
          Number(pending.rows[0].sent_at) > time - EMAIL_COOLDOWN
        )
          return false;
        await client.query(
          `INSERT INTO pending_email_links(account_id,email,password_hash,token_hash,expires_at,sent_at)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(account_id) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,
             token_hash=excluded.token_hash,expires_at=excluded.expires_at,sent_at=excluded.sent_at`,
          [
            accountId,
            email,
            hash,
            tokenHash(token),
            time + REGISTER_LIFETIME,
            time,
          ],
        );
        return true;
      });
      if (queued) {
        try {
          await send(
            email,
            "Подключение почты к Drevo",
            `Вы запросили вход по почте для существующего аккаунта Drevo. Откройте ссылку в том же браузере, где вы вошли в этот аккаунт:\n${origin}/account#email-link=${token}\n\nСсылка действует 24 часа. Если с последнего входа через Яндекс или VK прошло больше 10 минут, войдите снова и повторно откройте ссылку. Если это были не вы, проигнорируйте письмо.`,
          );
        } catch {
          await transact((client) =>
            client.query(
              "DELETE FROM pending_email_links WHERE account_id=$1 AND token_hash=$2",
              [accountId, tokenHash(token)],
            ),
          );
          throw new Error("Не удалось отправить письмо. Попробуйте позднее.");
        }
      }
    },

    async verifyLink(accountId: string, token: unknown) {
      if (!validToken(token))
        throw new InvalidEmailCredential(
          "Ссылка подтверждения недействительна.",
        );
      const time = now();
      await transact(async (client) => {
        const found = await client.query<{ email: string; account_id: string }>(
          "SELECT email,account_id FROM pending_email_links WHERE token_hash=$1",
          [tokenHash(token)],
        );
        if (!found.rows[0] || found.rows[0].account_id !== accountId)
          throw new InvalidEmailCredential(
            "Ссылка предназначена для другого аккаунта или устарела.",
          );
        await client.query("SELECT pg_advisory_xact_lock(2407,hashtext($1))", [
          found.rows[0].email,
        ]);
        const pending = await client.query<{
          email: string;
          password_hash: string;
          expires_at: string;
        }>(
          "SELECT email,password_hash,expires_at FROM pending_email_links WHERE account_id=$1 AND token_hash=$2 FOR UPDATE",
          [accountId, tokenHash(token)],
        );
        const row = pending.rows[0];
        if (!row || Number(row.expires_at) <= time)
          throw new InvalidEmailCredential("Ссылка подтверждения устарела.");
        if (
          (
            await client.query(
              "SELECT 1 FROM account_email_credentials WHERE email=$1 OR account_id=$2",
              [row.email, accountId],
            )
          ).rowCount
        )
          throw new InvalidEmailCredential("Почта уже привязана к аккаунту.");
        await client.query(
          "INSERT INTO account_email_credentials(account_id,email,password_hash) VALUES($1,$2,$3)",
          [accountId, row.email, row.password_hash],
        );
        await client.query(
          "INSERT INTO account_identities(provider,subject,account_id) VALUES('email',$1,$2)",
          [row.email, accountId],
        );
        await client.query(
          "DELETE FROM pending_email_links WHERE account_id=$1",
          [accountId],
        );
      });
    },

    async resetPassword(token: unknown, value: unknown) {
      if (!validToken(token))
        throw new InvalidEmailCredential(
          "Ссылка восстановления недействительна.",
        );
      const password = validateAccountPassword(value);
      const hash = await hashAccountPassword(password);
      const time = now();
      await transact(async (client) => {
        const reset = await client.query<{ email: string; expires_at: string }>(
          "SELECT email,expires_at FROM email_password_resets WHERE token_hash=$1 FOR UPDATE",
          [tokenHash(token)],
        );
        if (!reset.rows[0] || Number(reset.rows[0].expires_at) <= time)
          throw new InvalidEmailCredential("Ссылка восстановления устарела.");
        const updated = await client.query<{ account_id: string }>(
          "UPDATE account_email_credentials SET password_hash=$2 WHERE email=$1 RETURNING account_id",
          [reset.rows[0].email, hash],
        );
        await client.query("DELETE FROM email_password_resets WHERE email=$1", [
          reset.rows[0].email,
        ]);
        await client.query("DELETE FROM account_sessions WHERE user_id=$1", [
          updated.rows[0].account_id,
        ]);
      });
    },
  };
}
