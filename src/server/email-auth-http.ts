import type { IncomingMessage, ServerResponse } from "node:http";
import nodemailer from "nodemailer";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import {
  emailCredentials,
  InvalidEmailCredential,
} from "./email-credentials.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import {
  createRequestLimiter,
  requestClientKey,
} from "./request-rate-limit.ts";
import { postgresEmailRateLimit } from "./postgres-email-rate-limit.ts";

type EmailSender = (to: string, subject: string, text: string) => Promise<void>;

function configuredSender(): EmailSender | null {
  const { SMTP_HOST, SMTP_FROM, SMTP_USER, SMTP_PASSWORD } = process.env;
  const port = Number(process.env.SMTP_PORT || 587);
  if (!SMTP_HOST || !SMTP_FROM || !SMTP_USER || !SMTP_PASSWORD) return null;
  if (
    !/^[A-Za-z0-9.-]{1,253}$/.test(SMTP_HOST) ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(SMTP_FROM) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Некорректная конфигурация SMTP.");
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return async (to, subject, text) => {
    await transport.sendMail({ from: SMTP_FROM, to, subject, text });
  };
}

export function emailAuthHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  origin?: string,
  sender: EmailSender | null = configuredSender(),
) {
  const enabled =
    db.kind === "postgres" && !!db.postgresTransaction && !!origin && !!sender;
  const credentials = enabled ? emailCredentials(db, sender!, origin!) : null;
  const sharedLimit = enabled ? postgresEmailRateLimit(db) : null;
  const ipLimit = createRequestLimiter({ limit: 25, windowMs: 10 * 60_000 });
  const addressLimit = createRequestLimiter({
    limit: 8,
    windowMs: 10 * 60_000,
  });
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(JSON.stringify(data));
    return true;
  };

  async function input(req: IncomingMessage) {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new InvalidEmailCredential("Ожидается JSON.");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 4096)
        throw new InvalidEmailCredential("Запрос слишком большой.");
      chunks.push(Buffer.from(chunk));
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new InvalidEmailCredential("Некорректный JSON.");
    }
  }

  return {
    enabled,
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (!url.pathname.startsWith("/api/auth/email/")) return false;
      if (!credentials)
        return json(res, 503, { error: "Вход по почте пока не настроен." });
      if (req.method !== "POST")
        return json(res, 405, { error: "Метод не поддерживается." });
      if (!isSameOriginRequest(req, origin))
        return json(res, 403, { error: "Недопустимый источник запроса." });
      const peer = req.socket.remoteAddress || "";
      const proxied =
        peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      const client = requestClientKey(
        proxied ? req.headers["x-real-ip"] : undefined,
        peer,
      );
      if (!ipLimit.allow(client))
        return json(res, 429, {
          error: "Слишком много попыток. Повторите позже.",
        });
      try {
        const body = await input(req);
        const address =
          typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (address && !addressLimit.allow(address))
          return json(res, 429, {
            error: "Слишком много попыток. Повторите позже.",
          });
        if (!(await sharedLimit!.allow(client, address)))
          return json(res, 429, {
            error: "Слишком много попыток. Повторите позже.",
          });
        if (url.pathname === "/api/auth/email/register") {
          await credentials.requestRegistration({
            email: body.email,
            name: body.name,
            password: body.password,
          });
          return json(res, 202, {
            message: "Если адрес доступен, письмо с подтверждением отправлено.",
          });
        }
        if (url.pathname === "/api/auth/email/verify") {
          const account = await credentials.verifyRegistration(body.token);
          await auth.issueAccountSession(req, res, account.accountId);
          return json(res, 200, { archiveId: account.archiveId });
        }
        if (url.pathname === "/api/auth/email/login") {
          const account = await credentials.login({
            email: body.email,
            password: body.password,
          });
          await auth.issueAccountSession(req, res, account.accountId);
          return json(res, 200, { archiveId: account.archiveId });
        }
        if (url.pathname === "/api/auth/email/reset/request") {
          await credentials.requestReset(body.email);
          return json(res, 202, {
            message: "Если адрес зарегистрирован, письмо отправлено.",
          });
        }
        if (url.pathname === "/api/auth/email/reset/complete") {
          await credentials.resetPassword(body.token, body.password);
          return json(res, 200, { message: "Пароль изменён. Войдите заново." });
        }
        if (url.pathname === "/api/auth/email/link/request") {
          const accountId = await auth.accountId(req);
          if (!accountId)
            return json(res, 401, { error: "Сначала войдите в аккаунт." });
          if (!(await auth.recentOAuthSession(req)))
            return json(res, 403, {
              error: "Для подключения почты снова войдите через Яндекс или VK.",
            });
          await credentials.requestLink(accountId, {
            email: body.email,
            password: body.password,
          });
          return json(res, 202, {
            message: "Если адрес доступен, письмо с подтверждением отправлено.",
          });
        }
        if (url.pathname === "/api/auth/email/link/verify") {
          const accountId = await auth.accountId(req);
          if (!accountId)
            return json(res, 401, {
              error: "Войдите в исходный аккаунт и снова откройте ссылку.",
            });
          if (!(await auth.recentOAuthSession(req)))
            return json(res, 403, {
              error:
                "Снова войдите через Яндекс или VK и откройте ссылку из письма.",
            });
          await credentials.verifyLink(accountId, body.token);
          return json(res, 200, { linked: true });
        }
        return json(res, 404, { error: "Неизвестный запрос." });
      } catch (error) {
        if (error instanceof InvalidEmailCredential)
          return json(res, url.pathname.endsWith("/login") ? 401 : 400, {
            error: error.message,
          });
        throw error;
      }
    },
  };
}
