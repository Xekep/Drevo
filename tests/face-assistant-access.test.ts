import test from "node:test";
import assert from "node:assert/strict";
import {
  detectFacesWithCurrentAccess,
  faceRecognitionAvailable,
  warmFaceAssistant,
} from "../src/vision/face-assistant.ts";

test("browser inference rechecks access after an earlier full-tier status", async () => {
  const originalFetch = globalThis.fetch;
  let enabled = true;
  let inferenceCalls = 0;
  globalThis.fetch = async () => Response.json({ enabled });
  try {
    assert.equal(await faceRecognitionAvailable(), true);
    // The account is downgraded while the model or image is loading.
    enabled = false;
    await assert.rejects(
      detectFacesWithCurrentAccess(async () => {
        inferenceCalls++;
        return [{ face: true }];
      }),
      { name: "AbortError" },
    );
    assert.equal(inferenceCalls, 0);

    enabled = true;
    assert.deepEqual(
      await detectFacesWithCurrentAccess(async () => {
        inferenceCalls++;
        return [{ face: true }];
      }),
      [{ face: true }],
    );
    assert.equal(inferenceCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser model warmup stops when face access is disabled", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ enabled: false });
  try {
    await assert.rejects(warmFaceAssistant(), { name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
