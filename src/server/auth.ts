import type { StoreDatabase } from "./store-database.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchiveUser } from "../domain/access.ts";
import type { userStore } from "./users.ts";
import {
  newSessionToken,
  sessionTokenHash,
  validSessionToken,
  SESSION_MAX_AGE,
} from "./session-token.ts";
export { SESSION_MAX_AGE } from "./session-token.ts";
const RENEW_INTERVAL = 24 * 60 * 60 * 1000;
const VISIT_INTERVAL = 60 * 1000;
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
  const platformAdmin =
    db.kind === "postgres"
      ? db.prepare("", "SELECT 1 AS allowed FROM platform_admins WHERE account_id=?")
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
    if (local)
      return {
        id: "local",
        name: "На этом компьютере",
        role: "admin",
        createdAt: "",
        approved: true,
      };
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
    issueSession,
    async sessionSummary(req: IncomingMessage) {
      if (local) return { currentExpiresAt: null, otherCount: 0 };
      const session = await sessionFor(req);
      if (!session || !(await users.get(session.userId))) return null;
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
      if (!session || !(await users.get(session.userId))) return null;
      return Number(
        (await revokeOthers.run(session.userId, session.tokenHash)).changes,
      );
    },
    async refreshSession(req: IncomingMessage, res: ServerResponse) {
      if (local || req.headers["sec-fetch-site"] === "cross-site") return;
      const session = await sessionFor(req);
      if (!session) return;
      const user = await users.get(session.userId);
      if (!user) return;
      const now = Date.now();
      // Persist authenticated activity at most once per minute per account.
      // Reading a user in the admin list must never count as their visit.
      if (
        !user.lastVisitAt ||
        Date.parse(user.lastVisitAt) <= now - VISIT_INTERVAL
      )
        await users.recordVisit(user.id, now, VISIT_INTERVAL);
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
      (await currentUser(req))?.approved === true &&
      ["admin", "researcher", "relative"].includes(
        (await currentUser(req))?.role || "",
      ),
    isAdmin: async (req: IncomingMessage) =>
      (await currentUser(req))?.approved === true &&
      (await currentUser(req))?.role === "admin",
    isPlatformAdmin: async (req: IncomingMessage) => {
      const user = await currentUser(req);
      if (!user?.approved) return false;
      if (local) return true;
      return platformAdmin
        ? !!(await platformAdmin.get(user.id))?.allowed
        : user.role === "admin";
    },
    async logout(req: IncomingMessage, res: ServerResponse) {
      await revoke.run(sessionTokenHash(cookie(req)));
      setCookie(res, "", 0);
    },
  };
}
