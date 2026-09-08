import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchiveUser } from "../domain/access.ts";
import type { userStore } from "./users.ts";
export function createAuth(
  users: ReturnType<typeof userStore>,
  publicOrigin?: string,
) {
  const local = !publicOrigin,
    secure = publicOrigin?.startsWith("https://") ? "; Secure" : "";
  const sessions = new Map<string, { userId: string; expires: number }>();
  const cookie = (req: IncomingMessage) =>
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("drevo_session="))
      ?.slice(14) || "";
  function currentUser(req: IncomingMessage): ArchiveUser | null {
    if (local)
      return {
        id: "local",
        name: "На этом компьютере",
        role: "admin",
        createdAt: "",
      };
    const token = cookie(req),
      session = sessions.get(token);
    if (!session || session.expires <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return users.get(session.userId);
  }
  function issueSession(
    req: IncomingMessage,
    res: ServerResponse,
    profile: { id: string; name: string },
  ) {
    const user = users.register(profile.id, profile.name);
    sessions.delete(cookie(req));
    for (const [key, s] of sessions)
      if (s.expires < Date.now()) sessions.delete(key);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, {
      userId: user.id,
      expires: Date.now() + 12 * 60 * 60 * 1000,
    });
    const previous = res.getHeader("Set-Cookie"),
      cookies = previous
        ? Array.isArray(previous)
          ? previous
          : [String(previous)]
        : [];
    res.setHeader("Set-Cookie", [
      ...cookies,
      `drevo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`,
    ]);
  }
  return {
    local,
    currentUser,
    issueSession,
    privateArchive: process.env.ARCHIVE_PRIVATE === "1",
    canEdit: (req: IncomingMessage) =>
      ["admin", "relative"].includes(currentUser(req)?.role || ""),
    isAdmin: (req: IncomingMessage) => currentUser(req)?.role === "admin",
    logout(req: IncomingMessage, res: ServerResponse) {
      sessions.delete(cookie(req));
      res.setHeader(
        "Set-Cookie",
        `drevo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
      );
    },
  };
}
