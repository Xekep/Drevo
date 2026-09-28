import { createOAuthFlow, type OAuthOptions } from "./oauth-flow.ts";

/** Токен провайдера остаётся на сервере и не сохраняется. */
export function createYandexOAuth(options: OAuthOptions) {
  const fetcher = options.fetcher || fetch;
  return createOAuthFlow(options, {
    id: "yandex",
    name: "Яндекс",
    configured: !!(options.clientId && options.clientSecret),
    authorize({ state, callback, challenge }) {
      const target = new URL("https://oauth.yandex.ru/authorize");
      target.search = new URLSearchParams({
        response_type: "code",
        client_id: options.clientId!,
        redirect_uri: callback,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        force_confirm: "yes",
      }).toString();
      return target;
    },
    async profile({ code, verifier, callback, signal }) {
      const response = await fetcher("https://oauth.yandex.ru/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: options.clientId!,
          client_secret: options.clientSecret!,
          redirect_uri: callback,
          code_verifier: verifier,
        }),
        signal: signal,
      });
      if (!response.ok) throw new Error("Token exchange failed");
      const token = (await response.json()) as { access_token?: unknown };
      if (typeof token.access_token !== "string")
        throw new Error("Invalid token");
      const profileResponse = await fetcher(
        "https://login.yandex.ru/info?format=json",
        {
          headers: { Authorization: `OAuth ${token.access_token}` },
          signal: signal,
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
      return { id: profile.id, name: (name || profile.id).slice(0, 200) };
    },
  });
}
