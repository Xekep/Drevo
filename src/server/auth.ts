import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchiveUser } from "../domain/access.ts";
import type { userStore } from "./users.ts";
export const SESSION_MAX_AGE = 90 * 24 * 60 * 60;
const RENEW_INTERVAL = 24 * 60 * 60 * 1000;
export function createAuth(
  users: ReturnType<typeof userStore>,
  db: DatabaseSync,
  publicOrigin?: string,
) {
  const local = !publicOrigin,
    secure = publicOrigin?.startsWith("https://") ? "; Secure" : "";
  db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);`);
  const removeExpired = db.prepare(
    "DELETE FROM auth_sessions WHERE expires_at <= ?",
  );
  removeExpired.run(Date.now());
  const hash = (token: string) =>
    createHash("sha256").update(token).digest("hex");
  const lookup = db.prepare(
    "SELECT user_id, expires_at FROM auth_sessions WHERE token_hash=?",
  );
  const revoke = db.prepare("DELETE FROM auth_sessions WHERE token_hash=?");
  const cookie = (req: IncomingMessage) =>
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("drevo_session="))
      ?.slice(14) || "";
  function sessionFor(req: IncomingMessage) {
    const token = cookie(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenHash = hash(token);
    const row = lookup.get(tokenHash);
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
      revoke.run(tokenHash);
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
  function currentUser(req: IncomingMessage): ArchiveUser | null {
    if (local)
      return {
        id: "local",
        name: "На этом компьютере",
        role: "admin",
        createdAt: "",
      };
    const session = sessionFor(req);
    return session ? users.get(session.userId) : null;
  }
  function issueSession(
    req: IncomingMessage,
    res: ServerResponse,
    profile: { id: string; name: string },
  ) {
    const user = users.register(profile.id, profile.name);
    revoke.run(hash(cookie(req)));
    removeExpired.run(Date.now());
    const token = randomBytes(32).toString("hex");
    db.prepare(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    ).run(hash(token), user.id, Date.now() + SESSION_MAX_AGE * 1000);
    setCookie(res, token);
  }
  return {
    local,
    currentUser,
    issueSession,
    refreshSession(req: IncomingMessage, res: ServerResponse) {
      if (local || req.headers["sec-fetch-site"] === "cross-site") return;
      const session = sessionFor(req);
      if (!session || !users.get(session.userId)) return;
      // Renew at most once per day; ordinary image/API reads do not write to SQLite.
      if (
        session.expires >
        Date.now() + SESSION_MAX_AGE * 1000 - RENEW_INTERVAL
      )
        return;
      db.prepare(
        "UPDATE auth_sessions SET expires_at=? WHERE token_hash=?",
      ).run(Date.now() + SESSION_MAX_AGE * 1000, session.tokenHash);
      setCookie(res, session.token);
    },
    privateArchive: process.env.ARCHIVE_PRIVATE === "1",
    canEdit: (req: IncomingMessage) =>
      ["admin", "relative"].includes(currentUser(req)?.role || ""),
    isAdmin: (req: IncomingMessage) => currentUser(req)?.role === "admin",
    logout(req: IncomingMessage, res: ServerResponse) {
      revoke.run(hash(cookie(req)));
      setCookie(res, "", 0);
    },
  };
}
