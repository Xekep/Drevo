import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { emailAuthSettingsStore } from "./email-auth-settings.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { PlatformAccessBusy, PlatformAccessDenied } from "./platform-access.ts";
import { createRequestLimiter } from "./request-rate-limit.ts";
import { validMailAddress } from "./email-sender.ts";

export function adminEmailAuthHttp(auth: Awaited<ReturnType<typeof createAuth>>,
  settings: ReturnType<typeof emailAuthSettingsStore>, origin?: string) {
  const tests = createRequestLimiter({ limit: 3, windowMs: 10 * 60_000 });
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const test = url.pathname === "/api/admin/auth/email/test";
    if (!test && url.pathname !== "/api/admin/auth/email") return false;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
      return true;
    };
    const session = await auth.accountSession(req);
    if (!(await auth.isPlatformAdmin(req))) return json(session ? 403 : 401, {
      error: "Настройки входа доступны только администратору платформы.",
    });
    if (!test && req.method === "GET") return json(200, await settings.read());
    if (req.method !== (test ? "POST" : "PUT")) return json(405, { error: "Метод не поддерживается." });
    if (!isSameOriginRequest(req, origin)) return json(403, { error: "Недопустимый источник запроса." });
    if (!req.headers["content-type"]?.startsWith("application/json")) return json(415, { error: "Ожидается JSON." });
    if (!session) return json(403, { error: "Для настройки нужен действующий аккаунт администратора платформы." });
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) return json(413, { error: "Слишком большой запрос." });
        chunks.push(Buffer.from(chunk));
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!test) return json(200, await settings.write(value, session));
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).some((key) => key !== "to") ||
          typeof (value as { to?: unknown }).to !== "string" ||
          !validMailAddress((value as { to: string }).to.trim())) throw new RangeError("Укажите email получателя.");
      if (!tests.allow(session.accountId)) return json(429, { error: "Можно отправить три тестовых письма за 10 минут." });
      const sender = await settings.testSender(session);
      try {
        await sender((value as { to: string }).to.trim(), "Drevo — проверка почты",
          "Тестовое письмо Drevo. SMTP-сервер принял отправку. Проверьте доставку, в том числе папку «Спам».");
      } catch {
        return json(502, { error: "SMTP не принял письмо. Проверьте адрес сервера, порт, логин, пароль и отправителя." });
      }
      return json(200, { message: "SMTP принял письмо. Проверьте его получение, в том числе папку «Спам»." });
    } catch (error) {
      return json(error instanceof PlatformAccessDenied ? 403 : error instanceof PlatformAccessBusy ? 409 :
        error instanceof SyntaxError || error instanceof RangeError ? 400 : 500, {
        error: error instanceof PlatformAccessDenied ? "Права администратора отозваны." :
          error instanceof PlatformAccessBusy ? "Проверка прав занята. Повторите запрос." :
          error instanceof SyntaxError ? "Некорректный JSON." : error instanceof RangeError ? error.message :
          "Не удалось обработать настройки почты. При утрате ключа шифрования сохраните пароль заново.",
      });
    }
  };
}
