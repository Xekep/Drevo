import { createOAuthFlow, type OAuthOptions } from "./oauth-flow.ts";

/** VK ID Authorization Code + PKCE; endpoints/fields follow VKCOM/vkid-web-sdk. */
export function createVkOAuth(options: OAuthOptions) {
  const fetcher = options.fetcher || fetch;
  return createOAuthFlow(options, {
    id: "vk",
    name: "VK",
    configured: /^[1-9][0-9]*$/.test(options.clientId || ""),
    authorize({ state, callback, challenge, clientId }) {
      const target = new URL("https://id.vk.ru/authorize");
      target.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: callback,
        state,
        code_challenge: challenge,
        code_challenge_method: "s256",
      }).toString();
      return target;
    },
    async profile({ code, state, verifier, callback, url, signal, clientId }) {
      const device = url.searchParams.get("device_id");
      if (!device || device.length > 1024)
        throw new Error("Invalid VK device ID");
      const tokenResponse = await fetcher("https://id.vk.ru/oauth2/auth", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: callback,
          code,
          code_verifier: verifier,
          device_id: device,
          state,
        }),
        signal,
      });
      if (!tokenResponse.ok) throw new Error("VK token exchange failed");
      const token = await tokenResponse.json();
      if (
        token.error ||
        typeof token.access_token !== "string" ||
        !token.access_token ||
        token.state !== state
      )
        throw new Error("Invalid VK token response");
      const profileResponse = await fetcher(
        "https://id.vk.ru/oauth2/user_info",
        {
          method: "POST",
          body: new URLSearchParams({
            client_id: clientId,
            access_token: token.access_token,
          }),
          signal,
        },
      );
      if (!profileResponse.ok) throw new Error("VK profile request failed");
      const result = await profileResponse.json();
      const profile = result.user;
      const id = String(profile?.user_id ?? "");
      if (
        result.error ||
        !/^[1-9][0-9]{0,19}$/.test(id) ||
        id !== String(token.user_id)
      )
        throw new Error("Invalid VK profile ID");
      const name = [profile.first_name, profile.last_name]
        .filter(
          (part): part is string => typeof part === "string" && !!part.trim(),
        )
        .map((part) => part.trim())
        .join(" ");
      // Legacy Yandex IDs stay unchanged; subjects from different providers never collide.
      return {
        id: `vk:${id}`,
        name: (name || `Участник VK ${id}`).slice(0, 200),
      };
    },
  });
}
