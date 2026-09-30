import test from "node:test";
import assert from "node:assert/strict";
import {
  pruneGeneratedResearchFiles,
  storeGeneratedResearchFile,
} from "../src/server/generated-research-files.ts";
import type { GeneratedResearchFile } from "../src/server/code-interpreter.ts";

const file = (bytes: number, expires: number): GeneratedResearchFile => ({
  ownerId: "owner",
  chatId: "chat",
  contentType: "application/pdf",
  name: "report.pdf",
  bytes: Buffer.alloc(bytes),
  expires,
});

test("PDF and calculation files share the same bounded cache", () => {
  const files = new Map<string, GeneratedResearchFile>();
  const first = storeGeneratedResearchFile(files, file(6, 200), 100, 8);
  assert.ok(first);
  assert.equal(storeGeneratedResearchFile(files, file(3, 200), 100, 8), null);
  assert.equal(files.size, 1);
  assert.ok(storeGeneratedResearchFile(files, file(2, 200), 100, 8));
  assert.equal(files.size, 2);
  assert.ok(storeGeneratedResearchFile(files, file(8, 300), 200, 8));
  assert.equal(files.size, 1, "expired files release their budget");
  pruneGeneratedResearchFiles(files, 300);
  assert.equal(files.size, 0, "expired files leave memory without another upload");
});
