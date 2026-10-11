import test from "node:test";
import assert from "node:assert/strict";
import { fetchAiStudioModels } from "../src/server/ai-models.ts";

test("catalog coalesces concurrent reads, caches success and isolates returned data", async () => {
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("OpenAI-Project"), "folder");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Api-Key test-key");
    assert.ok(init?.signal);
    await pending;
    return Response.json({ data: [
      { id: "gpt://folder/model/latest", owned_by: "Yandex" },
      { id: "emb://folder/text", owned_by: "Yandex" },
    ] });
  };
  const options = { baseUrl: "https://example.test/v1/", apiKey: "test-key", folderId: "folder", fetcher };
  const first = fetchAiStudioModels(options);
  const second = fetchAiStudioModels(options);
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], [{ id: "gpt://folder/model/latest", label: "model", owner: "Yandex" }]);
  results[0][0].label = "Mutated";
  assert.equal(results[1][0].label, "model");
  assert.equal((await fetchAiStudioModels(options))[0].label, "model");
  assert.equal(calls, 1);
  await fetchAiStudioModels({ ...options, forceRefresh: true });
  assert.equal(calls, 2);
});

test("catalog cache cannot reuse results for another credential, folder or provider", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({ data: [{ id: `gpt://folder/model-${calls}` }] });
  };
  const options = { baseUrl: "https://example.test/v1", apiKey: "first-key", folderId: "folder", fetcher };
  await fetchAiStudioModels(options);
  await fetchAiStudioModels({ ...options, apiKey: "second-key" });
  await fetchAiStudioModels({ ...options, folderId: "other-folder" });
  await fetchAiStudioModels({ ...options, baseUrl: "https://other.test/v1" });
  assert.equal(calls, 4);
});

test("catalog failure is retryable instead of caching an empty model list", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    if (++calls === 1) throw new DOMException("Timeout", "TimeoutError");
    return Response.json({ data: [{ id: "gpt://folder/model" }] });
  };
  const options = { baseUrl: "https://example.test/v1", apiKey: "key", folderId: "folder", fetcher };
  await assert.rejects(fetchAiStudioModels(options), { name: "TimeoutError" });
  assert.equal((await fetchAiStudioModels(options)).length, 1);
  assert.equal(calls, 2);
});

test("catalog cache evicts older folders at its bounded capacity", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({ data: [{ id: "gpt://folder/model" }] });
  };
  const options = { baseUrl: "https://example.test/v1", apiKey: "key", fetcher };
  for (let i = 0; i < 9; i++) await fetchAiStudioModels({ ...options, folderId: `folder-${i}` });
  await fetchAiStudioModels({ ...options, folderId: "folder-8" });
  assert.equal(calls, 9);
  await fetchAiStudioModels({ ...options, folderId: "folder-0" });
  assert.equal(calls, 10);
});
