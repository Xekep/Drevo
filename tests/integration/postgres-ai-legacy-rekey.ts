import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { aiProviderCleanup } from "../../src/server/ai-provider-cleanup.ts";
import { aiResearchHttp } from "../../src/server/ai-research-http.ts";
import { aiSettingsStore } from "../../src/server/ai-settings.ts";
import { aiUsageStore } from "../../src/server/ai-usage.ts";
import { createAuth } from "../../src/server/auth.ts";
import { imagePreviews } from "../../src/server/image-previews.ts";
import { mediaStore } from "../../src/server/media.ts";
import { researchCatalogStore } from "../../src/server/research-catalog.ts";
import { researchSuggestionStore } from "../../src/server/research-suggestions.ts";
import { userStore } from "../../src/server/users.ts";
import { adaptLegacyAiFake } from "../legacy-ai-fake.ts";

export async function verifyAiLegacyChatRekey(
  archive: Parameters<typeof aiResearchHttp>[0]["archive"],
  client: Client,
  source: string,
  origin: string,
  proposalMember: string,
  proposalHeaders: Record<string, string>,
) {
      {
        const usageBeforeRekey = Number((await client.query(
          "SELECT coalesce(max(id),0) AS id FROM ai_usage WHERE archive_id='runtime-test' AND user_id=$1",
          [proposalMember],
        )).rows[0].id);
        const cleanup = await aiProviderCleanup(archive.db, source);
        const legacyChats = aiChatStore(archive.db, cleanup);
        const legacy = await legacyChats.create(proposalMember,
          JSON.stringify(["researcher", "all", ""]));
        const legacyLease = (await legacyChats.acquire(legacy.id))!;
        assert.equal(await legacyChats.bindNewRemote(legacy.id, "former-profile-remote", {
          baseUrl: "https://local-ai.invalid/v1", folderId: "folder-1", apiKey: "test-key",
        }, legacyLease), true);
        await legacyChats.release(legacy.id, legacyLease);
        const oldRef = String((await archive.db.prepare("", "SELECT provider_cleanup_ref FROM ai_chats WHERE id=?")
          .get(legacy.id))?.provider_cleanup_ref);
        assert.notEqual(oldRef, "undefined");
        await legacyChats.append(legacy.id, "user", "Earlier visible facts");
        await client.query("DELETE FROM platform_researchers WHERE account_id=$1", [proposalMember]);
        let newConversation = false;
        let restoredHistory = false;
        const adapted = adaptLegacyAiFake(async (url, init) => {
          if (String(url).endsWith("/models"))
            return Response.json({ data: [{ id: "gpt://folder-1/yandexgpt/rc", owned_by: "Yandex" }] });
          restoredHistory = String(init?.body).includes("Earlier visible facts");
          return Response.json({ choices: [{ message: {
            role: "assistant", content: "Answer under current profile",
          } }] });
        });
        const handler = aiResearchHttp({
          archive: archive,
          auth: await createAuth(await userStore(archive.db), archive.db,
            origin),
          suggestions: researchSuggestionStore(archive.db),
          aiSettings: await aiSettingsStore(archive.db),
          usage: aiUsageStore(archive.db),
          providerCleanup: cleanup,
          media: mediaStore(join(dirname(source), "uploads")),
          previewImage: imagePreviews(join(dirname(source), "previews")),
          researchCatalog: researchCatalogStore(archive.db),
          publicOrigin: origin,
          fetcher: async (url, init) => {
            if (String(url).endsWith("/conversations") && init?.method === "POST")
              newConversation = true;
            return adapted(url, init);
          },
        });
        const server = createServer((req, res) => {
          void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
            .catch((error) => res.destroy(error));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
          const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          const history = await fetch(url + `/api/ai/chats/${legacy.id}`,
            { headers: proposalHeaders });
          assert.equal(history.status, 200, "same-visibility former staff history remains readable");
          assert.match(await history.text(), /Earlier visible facts/);
          const resumed = await fetch(url + "/api/ai/chat", {
            method: "POST", headers: proposalHeaders,
            body: JSON.stringify({ chatId: legacy.id, message: "Continue with current role" }),
          });
          assert.equal(resumed.status, 200, await resumed.clone().text());
          assert.equal(newConversation, true, "old provider context must not be reused");
          assert.equal(restoredHistory, true, "bounded local history is rehydrated under current instructions");
          const current = await aiChatStore(archive.db).read(legacy.id, proposalMember);
          assert.equal(current?.accessScope, JSON.stringify(["relative", "all", ""]));
          assert.notEqual(current?.yandexConversationId, "former-profile-remote");
          assert.equal((await archive.db.prepare("", "SELECT state FROM platform_ai_conversations WHERE id=?")
            .get(oldRef))?.state, "pending", "the previous provider context is durably queued for cleanup");
          console.log("runtime_ai_legacy_chat_rekey_ok");
        } finally {
          await client.query("INSERT INTO platform_researchers(account_id) VALUES($1) ON CONFLICT DO NOTHING",
            [proposalMember]);
          await client.query(
            "DELETE FROM ai_usage WHERE archive_id='runtime-test' AND user_id=$1 AND id>$2",
            [proposalMember, usageBeforeRekey],
          );
          await aiChatStore(archive.db).delete(legacy.id, proposalMember);
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await handler.close();
        }
      }
}
