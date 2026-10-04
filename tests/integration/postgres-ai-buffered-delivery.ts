import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { aiResearchHttp } from "../../src/server/ai-research-http.ts";
import { aiSettingsStore } from "../../src/server/ai-settings.ts";
import { aiUsageStore } from "../../src/server/ai-usage.ts";
import { createAuth } from "../../src/server/auth.ts";
import { imagePreviews } from "../../src/server/image-previews.ts";
import { mediaStore } from "../../src/server/media.ts";
import { researchCatalogStore } from "../../src/server/research-catalog.ts";
import { researchSuggestionStore } from "../../src/server/research-suggestions.ts";
import { userStore } from "../../src/server/users.ts";

/** Completed revokes before the buffered AI download boundary never send private bytes. */
export async function verifyAiBufferedDelivery(
  archive: Parameters<typeof aiResearchHttp>[0]["archive"],
  client: Client,
  source: string,
  ownerHeaders: Record<string, string>,
  generatedPath: string,
  origin: string,
) {
  for (const scenario of [
    {
      path: "/api/ai/export/gedcom?format=gedcom7",
      revoke: "UPDATE archive_owners SET user_id='reader' WHERE archive_id='runtime-test'",
      restore: "UPDATE archive_owners SET user_id='owner' WHERE archive_id='runtime-test'",
      privateText: "0 HEAD",
    },
    {
      path: generatedPath,
      revoke: "UPDATE archive_memberships SET approved=false WHERE archive_id='runtime-test' AND user_id='owner'",
      restore: "UPDATE archive_memberships SET approved=true WHERE archive_id='runtime-test' AND user_id='owner'",
      privateText: "%PDF- synthetic private report",
    },
  ]) {
    let reached!: () => void;
    let release!: () => void;
    const atDelivery = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = aiResearchHttp({
      archive,
      auth: await createAuth(await userStore(archive.db), archive.db, origin),
      suggestions: researchSuggestionStore(archive.db),
      aiSettings: await aiSettingsStore(archive.db),
      usage: aiUsageStore(archive.db),
      media: mediaStore(join(dirname(source), "uploads")),
      previewImage: imagePreviews(join(dirname(source), "previews")),
      researchCatalog: researchCatalogStore(archive.db),
      publicOrigin: origin,
      beforeBufferedDelivery: async (path) => {
        if (path !== new URL(scenario.path, origin).pathname) return;
        reached();
        await gate;
      },
    });
    const server = createServer((req, res) => {
      void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const pending = fetch(base + scenario.path, { headers: ownerHeaders });
      let timer!: ReturnType<typeof setTimeout>;
      const progress = await Promise.race([
        atDelivery.then(() => "gated"),
        pending.then(() => "responded"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timed out"), 10_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(progress, "gated", `${scenario.path} must reach the prepared download`);
      await client.query(scenario.revoke);
      release();
      const response = await pending;
      assert.equal(response.status, 403, `${scenario.path} must refuse completed revoke`);
      assert.doesNotMatch(await response.text(), new RegExp(scenario.privateText));
    } finally {
      release();
      await client.query(scenario.restore);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handler.close();
    }
  }
  console.log("runtime_ai_buffered_delivery_revocation_ok");
}
