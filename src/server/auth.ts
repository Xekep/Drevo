import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
const scrypt = promisify(scryptCallback);
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}
export function createAuth(publicOrigin?: string) {
  const local = !publicOrigin,
    hash = process.env.ARCHIVE_PASSWORD_HASH,
    user = process.env.ARCHIVE_USER || "xekep";
  if (
    !local &&
    !(
      process.env.YANDEX_CLIENT_ID &&
      process.env.YANDEX_CLIENT_SECRET &&
      process.env.YANDEX_ALLOWED_IDS
    ) &&
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash || "")
  )
    throw new Error("Задайте ARCHIVE_PASSWORD_HASH для сервера в интернете");
  const sessions = new Map<string, number>(),
    attempts = new Map<string, { count: number; until: number }>();
  const secure = publicOrigin?.startsWith("https://") ? "; Secure" : "";
  const cookie = (req: IncomingMessage) =>
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("drevo_session="))
      ?.slice(14) || "";
  function canEdit(req: IncomingMessage) {
    if (local) return true;
    const token = cookie(req),
      expires = sessions.get(token) || 0;
    if (expires <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }
  function issueSession(req: IncomingMessage, res: ServerResponse) {
    sessions.delete(cookie(req));
    for (const [key, expires] of sessions)
      if (expires < Date.now()) sessions.delete(key);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    const previous = res.getHeader("Set-Cookie");
    const cookies = previous
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
    canEdit,
    issueSession,
    passwordLogin: !!hash,
    privateArchive: process.env.ARCHIVE_PRIVATE === "1",
    async login(
      req: IncomingMessage,
      res: ServerResponse,
      username: string,
      password: string,
    ) {
      const address = String(
          req.headers["x-real-ip"] || req.socket.remoteAddress,
        ),
        now = Date.now();
      for (const [key, a] of attempts) if (a.until < now) attempts.delete(key);
      for (const [key, expires] of sessions)
        if (expires < now) sessions.delete(key);
      const attempt = attempts.get(address) || {
        count: 0,
        until: now + 15 * 60 * 1000,
      };
      attempts.set(address, attempt);
      if (attempt.count >= 10) return false;
      attempt.count++;
      const [salt, expected] = (hash || "").split(":");
      if (!salt || !expected) return false;
      const actual = (await scrypt(password, salt, 64)) as Buffer;
      if (
        !timingSafeEqual(Buffer.from(expected, "hex"), actual) ||
        username !== user
      )
        return false;
      attempts.delete(address);
      issueSession(req, res);
      return true;
    },
    logout(req: IncomingMessage, res: ServerResponse) {
      sessions.delete(cookie(req));
      res.setHeader(
        "Set-Cookie",
        `drevo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
      );
    },
  };
}
