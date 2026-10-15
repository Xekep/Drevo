import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { aiSettingsStore, defaultAiRoleProfile } from "../src/server/ai-settings.ts";
import { aiUsageStore } from "../src/server/ai-usage.ts";

for (const reported of [true, false]) test(`token budget stops paid tool continuations (provider usage: ${reported})`, async () => {
  const values = { YANDEX_AI_API_KEY: "synthetic-test-key", YANDEX_AI_FOLDER_ID: "folder", YANDEX_AI_MODEL: "model" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  const dir = await mkdtemp(join(tmpdir(), "drevo-token-http-"));
  let calls = 0;
  const app = await startServer(0, join(dir, "archive.sqlite"), true, undefined, async (url, init) => {
    if (String(url).endsWith("/conversations")) return Response.json({ id: "conversation" });
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    assert.ok(String(url).endsWith("/responses"));
    calls++;
    return Response.json({ id: `response-${calls}`, status: "completed",
      ...(reported ? { usage: { input_tokens: 70, output_tokens: 40 } } : {}),
      output: [{ type: "function_call", call_id: "insights", name: "get_archive_insights", arguments: "{}" }],
    });
  });
  try {
    const settings = await aiSettingsStore(app.archive.db), current = await settings.read();
    await settings.write({ ...current, roleProfiles: { ...current.roleProfiles,
      admin: { ...defaultAiRoleProfile(current), requestsPerMinute: 0, dailyRequests: 0, dailyTokens: 100 },
    } }, { id: "local", name: "Local", role: "admin", approved: true, createdAt: "" });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const send = () => fetch(base + "/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Сравни демографические данные архива, выполни анализ инструментами" }) });
    const response = await send();
    assert.equal(response.status, 429, await response.clone().text());
    await response.text();
    assert.equal(calls, 1, "a completed lookup cannot start another paid round after crossing or reserving the threshold");
    const summary = await aiUsageStore(app.archive.db).summary();
    assert.equal(summary.today.providerCalls, 1, "a denied continuation is not a provider call");
    assert.equal(summary.today.totalTokens, reported ? 110 : 0);
    assert.equal(summary.today.reservedTokens, reported ? 0 : 100);
    const rejected = await send();
    assert.equal(rejected.status, 429);
    await rejected.text();
    assert.equal(calls, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
