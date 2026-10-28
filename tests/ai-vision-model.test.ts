import test from "node:test";
import assert from "node:assert/strict";
import { aiVision } from "../src/server/ai-vision.ts";
import type { aiRuntimeConfig } from "../src/server/ai-settings.ts";

type Runtime = Awaited<ReturnType<typeof aiRuntimeConfig>>;
const runtime = { modelUri: "gpt://folder/custom-model", folderId: "folder", visionModel: "", baseUrl: "https://provider.invalid/v1", apiKey: "test" } as Runtime;

test("photo analysis inherits the role model without a hardcoded model or catalog lookup", async () => {
  const vision = aiVision(async () => { throw new Error("No catalog discovery expected"); });
  assert.equal(await vision.modelUri(runtime), runtime.modelUri);
  assert.equal(await vision.modelUri({ ...runtime, modelUri: "gpt://other/new-model", folderId: "other" }), "gpt://other/new-model");
  assert.equal(await vision.modelUri({ ...runtime, visionModel: "image-model" }), "gpt://folder/image-model");
  assert.equal(await vision.modelUri({ ...runtime, folderId: "", visionModel: "image-model" }), "gpt://folder/image-model");
  assert.equal(await vision.modelUri({ ...runtime, visionModel: "gpt://another/explicit" }), "gpt://another/explicit");
});

test("image input refusal explains the configured model instead of claiming a missing Qwen catalog", async () => {
  const vision = aiVision(async () => Response.json({ error: { message: "unsupported image" } }, { status: 400 }));
  await assert.rejects(vision.analyze("Опиши", "data:image/jpeg;base64,AA==", runtime, runtime.modelUri, new AbortController().signal),
    /не приняла изображение.*настройках роли/);
});
