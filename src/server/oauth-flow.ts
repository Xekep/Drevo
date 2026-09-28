import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createOAuthStartLimiter, oauthClientKey } from "./oauth-rate-limit.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  sqliteOAuthTransactions,
  type OAuthTransactions,
} from "./oauth-transactions.ts";
export type OAuthOptions = {
  origin?: string;
  clientId?: string;
  clientSecret?: string;
  issueSession: (
    req: IncomingMessage,
    res: ServerResponse,
    profile: { id: string; name: string },
  ) => void | Promise<void>;
  fetcher?: typeof fetch;
  db?: DatabaseSync;
  transactions?: OAuthTransactions;
};
type OAuthProvider = {
  id: "yandex" | "vk";
  name: string;
  configured: boolean;
  authorize(params: {
    state: string;
    challenge: string;
    callback: string;
  }): URL;
  profile(params: {
    code: string;
    state: string;
    verifier: string;
    callback: string;
    url: URL;
    signal: AbortSignal;
  }): Promise<{ id: string; name: string }>;
};
/** Общая защита Authorization Code + PKCE и выдача сессии архива. */
export function createOAuthFlow(
  options: OAuthOptions,
  provider: OAuthProvider,
) {
  if (!options.transactions && !options.db)
    throw new Error("Не задано хранилище OAuth-транзакций");
  const transactions =
    options.transactions || sqliteOAuthTransactions(options.db!);
  const enabled = !!options.origin && provider.configured;
  const starts = createOAuthStartLimiter();
  const path = `/auth/${provider.id}`;
  const callback = options.origin ? `${options.origin}${path}/callback` : "";
  const cookieName =
    provider.id === "yandex" ? "drevo_oauth_state" : "drevo_vk_oauth_state";
  const stateKey = (state: string) =>
    createHash("sha256").update(`${provider.id}:${state}`).digest("hex");
  const secure = options.origin?.startsWith("https://") ? "; Secure" : "";
  function fail(res: ServerResponse, status: number, message: string) {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(
      `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход в Древо</title><body><h1>Вход в Древо</h1><p>${message}</p><a href="/">Вернуться к архиву</a></body></html>`,
    );
  }
  return {
    enabled,
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (![path, `${path}/callback`].includes(url.pathname)) return false;
      if (req.method !== "GET") {
        fail(res, 405, "Для этого адреса требуется GET-запрос.");
        return true;
      }
      if (!enabled) {
        fail(
          res,
          503,
          `Вход через ${provider.name} пока не настроен. Обратитесь к администратору архива.`,
        );
        return true;
      }
      if (url.pathname === path) {
        const now = Date.now();
        await transactions.pruneExpired(now);
        const client = oauthClientKey(
          req.headers["x-real-ip"],
          req.socket.remoteAddress,
        );
        if (!starts.allow(client)) {
          res.setHeader("Retry-After", "600");
          fail(res, 429, "Слишком много попыток входа. Попробуйте позже.");
          return true;
        }
        if ((await transactions.countPending(now)) >= 1000) {
          res.setHeader("Retry-After", "600");
          fail(res, 429, "Слишком много запросов. Попробуйте позже.");
          return true;
        }
        const state = randomBytes(32).toString("base64url"),
          verifier = randomBytes(32).toString("base64url");
        await transactions.create(
          stateKey(state),
          verifier,
          now + 10 * 60 * 1000,
        );
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${state}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=600${secure}`,
        );
        const target = provider.authorize({
          state,
          callback,
          challenge: createHash("sha256").update(verifier).digest("base64url"),
        });
        res.writeHead(302, {
          Location: target.href,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end();
        return true;
      }
      const state = url.searchParams.get("state") || "",
        cookie =
          req.headers.cookie
            ?.split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith(`${cookieName}=`))
            ?.slice(cookieName.length + 1) || "";
      const stateHash = stateKey(state);
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=0${secure}`,
      );
      const invalidState =
        !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        !/^[A-Za-z0-9_-]{43}$/.test(cookie) ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(cookie));
      const transaction = invalidState
        ? null
        : await transactions.consume(stateHash, Date.now());
      if (!transaction) {
        fail(
          res,
          400,
          "Запрос входа устарел или не совпадает с этим браузером. Начните вход заново.",
        );
        return true;
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code) {
        fail(
          res,
          400,
          `Вход через ${provider.name} отменён. Можно попробовать ещё раз.`,
        );
        return true;
      }
      try {
        const profile = await provider.profile({
          code,
          state,
          verifier: transaction.verifier,
          callback,
          url,
          signal: AbortSignal.timeout(15000),
        });
        await options.issueSession(req, res, profile);
        res.writeHead(303, {
          Location: "/",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end();
      } catch {
        fail(
          res,
          502,
          `Не удалось завершить вход через ${provider.name}. Попробуйте ещё раз позже.`,
        );
      }
      return true;
    },
  };
}
