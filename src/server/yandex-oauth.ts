import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createOAuthStartLimiter, oauthClientKey } from "./oauth-rate-limit.ts";
type Options = {
  origin?: string;
  clientId?: string;
  clientSecret?: string;
  issueSession: (
    req: IncomingMessage,
    res: ServerResponse,
    profile: { id: string; name: string },
  ) => void;
  fetcher?: typeof fetch;
};
/** Минимальный Authorization Code + PKCE. Токен Яндекса не передаётся браузеру и не сохраняется. */
export function createYandexOAuth(options: Options) {
  const enabled = !!(
    options.origin &&
    options.clientId &&
    options.clientSecret
  );
  const pending = new Map<string, { verifier: string; expires: number }>(),
    fetcher = options.fetcher || fetch,
    starts = createOAuthStartLimiter();
  const callback = options.origin
    ? `${options.origin}/auth/yandex/callback`
    : "";
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
      if (!["/auth/yandex", "/auth/yandex/callback"].includes(url.pathname))
        return false;
      if (req.method !== "GET") {
        fail(res, 405, "Для этого адреса требуется GET-запрос.");
        return true;
      }
      if (!enabled) {
        fail(
          res,
          503,
          "Вход через Яндекс пока не настроен. Обратитесь к администратору архива.",
        );
        return true;
      }
      if (url.pathname === "/auth/yandex") {
        const now = Date.now();
        for (const [key, value] of pending)
          if (value.expires < now) pending.delete(key);
        const client = oauthClientKey(
          req.headers["x-real-ip"],
          req.socket.remoteAddress,
        );
        if (!starts.allow(client)) {
          res.setHeader("Retry-After", "600");
          fail(res, 429, "Слишком много попыток входа. Попробуйте позже.");
          return true;
        }
        if (pending.size >= 1000) {
          res.setHeader("Retry-After", "600");
          fail(res, 429, "Слишком много запросов. Попробуйте позже.");
          return true;
        }
        const state = randomBytes(32).toString("base64url"),
          verifier = randomBytes(32).toString("base64url");
        pending.set(state, { verifier, expires: now + 10 * 60 * 1000 });
        res.setHeader(
          "Set-Cookie",
          `drevo_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/yandex; Max-Age=600${secure}`,
        );
        const target = new URL("https://oauth.yandex.ru/authorize");
        target.search = new URLSearchParams({
          response_type: "code",
          client_id: options.clientId!,
          redirect_uri: callback,
          state,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
          force_confirm: "yes",
        }).toString();
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
            .find((s) => s.startsWith("drevo_oauth_state="))
            ?.slice(18) || "";
      const transaction = pending.get(state);
      res.setHeader(
        "Set-Cookie",
        `drevo_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/yandex; Max-Age=0${secure}`,
      );
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        !/^[A-Za-z0-9_-]{43}$/.test(cookie) ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(cookie)) ||
        !transaction ||
        transaction.expires < Date.now()
      ) {
        fail(
          res,
          400,
          "Запрос входа устарел или не совпадает с этим браузером. Начните вход заново.",
        );
        return true;
      }
      pending.delete(state);
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code) {
        fail(res, 400, "Вход через Яндекс отменён. Можно попробовать ещё раз.");
        return true;
      }
      try {
        const response = await fetcher("https://oauth.yandex.ru/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: options.clientId!,
            client_secret: options.clientSecret!,
            redirect_uri: callback,
            code_verifier: transaction.verifier,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Token exchange failed");
        const token = (await response.json()) as { access_token?: unknown };
        if (typeof token.access_token !== "string")
          throw new Error("Invalid token");
        const profileResponse = await fetcher(
          "https://login.yandex.ru/info?format=json",
          {
            headers: { Authorization: `OAuth ${token.access_token}` },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!profileResponse.ok) throw new Error("Profile request failed");
        const profile = (await profileResponse.json()) as {
          id?: unknown;
          display_name?: unknown;
          real_name?: unknown;
          login?: unknown;
        };
        if (
          typeof profile.id !== "string" ||
          !profile.id ||
          profile.id.length > 100
        )
          throw new Error("Invalid profile ID");
        const name = [
          profile.display_name,
          profile.real_name,
          profile.login,
        ].find((v) => typeof v === "string" && v.trim()) as string | undefined;
        options.issueSession(req, res, {
          id: profile.id,
          name: (name || profile.id).slice(0, 200),
        });
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
          "Не удалось завершить вход через Яндекс. Попробуйте ещё раз позже.",
        );
      }
      return true;
    },
  };
}
