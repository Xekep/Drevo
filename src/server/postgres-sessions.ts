import type pg from "pg";
import {
  newSessionToken,
  sessionTokenHash,
  validSessionToken,
  SESSION_MAX_AGE,
} from "./session-token.ts";
import { InvalidEmailCredential } from "./email-credentials.ts";

const MAX_AGE_MS = SESSION_MAX_AGE * 1000;
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VISIT_INTERVAL_MS = 60 * 1000;
const EXPIRED_SESSION_CLEANUP_BATCH = 100;

/** Caller owns the transaction together with account and archive provisioning. */
export async function issuePostgresSessionInTransaction(
  client: pg.Client,
  accountId: string,
  previousToken = "",
  now = Date.now(),
) {
  const token = newSessionToken();
  const expiresAt = now + MAX_AGE_MS;
  if (validSessionToken(previousToken))
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [
      sessionTokenHash(previousToken),
    ]);
  await client.query(
    `DELETE FROM account_sessions WHERE token_hash IN
      (SELECT token_hash FROM account_sessions
        WHERE expires_at<=$1 ORDER BY expires_at LIMIT $2)`,
    [now, EXPIRED_SESSION_CLEANUP_BATCH],
  );
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
    [sessionTokenHash(token), accountId, expiresAt],
  );
  await client.query("UPDATE accounts SET last_visit_at=$2 WHERE id=$1", [
    accountId,
    new Date(now).toISOString(),
  ]);
  return { token, expiresAt };
}

/** Hold the credential row until insertion so reset cannot miss this session. */
export async function issuePostgresEmailSessionInTransaction(
  client: pg.Client,
  accountId: string,
  expectedPasswordHash: string,
  previousToken = "",
) {
  const credential = await client.query(
    `SELECT 1 FROM account_email_credentials
     WHERE account_id=$1 AND password_hash=$2 FOR UPDATE`,
    [accountId, expectedPasswordHash],
  );
  if (!credential.rowCount)
    throw new InvalidEmailCredential("Неверная почта или пароль.");
  return issuePostgresSessionInTransaction(client, accountId, previousToken);
}

/** An expired or revoked token cannot be extended by a late request. */
export async function renewPostgresSession(
  client: pg.Client,
  token: string,
  now = Date.now(),
) {
  if (!validSessionToken(token)) return false;
  const result = await client.query(
    `UPDATE account_sessions SET expires_at=$2
      WHERE token_hash=$1 AND expires_at>$3 AND expires_at<=$4`,
    [
      sessionTokenHash(token),
      now + MAX_AGE_MS,
      now,
      now + MAX_AGE_MS - RENEW_INTERVAL_MS,
    ],
  );
  return result.rowCount === 1;
}

export async function recordPostgresVisit(
  client: pg.Client,
  token: string,
  now = Date.now(),
) {
  if (!validSessionToken(token)) return false;
  const result = await client.query(
    `UPDATE accounts a SET last_visit_at=$2
       FROM account_sessions s
      WHERE s.user_id=a.id AND s.token_hash=$1 AND s.expires_at>$3
        AND (a.last_visit_at IS NULL OR a.last_visit_at<$4)`,
    [
      sessionTokenHash(token),
      new Date(now).toISOString(),
      now,
      new Date(now - VISIT_INTERVAL_MS).toISOString(),
    ],
  );
  return result.rowCount === 1;
}

export async function revokePostgresSession(client: pg.Client, token: string) {
  if (!validSessionToken(token)) return false;
  const result = await client.query(
    "DELETE FROM account_sessions WHERE token_hash=$1",
    [sessionTokenHash(token)],
  );
  return result.rowCount === 1;
}
