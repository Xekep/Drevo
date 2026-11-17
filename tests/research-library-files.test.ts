import test from "node:test";
import assert from "node:assert/strict";
import { researchLibraryFiles } from "../src/domain/research-library-files.ts";

test("chat library includes uploads and assistant downloads without inventing file sizes", () => {
  const upload = { name: "input.csv", url: "/api/ai/attachments/chat/input", size: 512, type: "text/csv" };
  const result = { name: "result.xlsx", url: "/api/ai/files/chat/result" };
  const generated = { ...result, size: 1234, expires: 1_800_000, contentType: "application/octet-stream" };
  const messages = [
    { role: "user", attachments: [upload] },
    { role: "assistant", generatedFileMeta: [generated], files: [
      result,
      { name: "tree.pdf", url: "drevo:tree-pdf:all" },
      { name: "input.csv", url: upload.url },
    ] },
    { role: "assistant", files: [result] },
  ];
  const saved = structuredClone(messages), files = researchLibraryFiles(messages);
  assert.equal(files.length, 3);
  assert.deepEqual(files[0], { name: upload.name, url: upload.url, size: upload.size, canAsk: true });
  assert.deepEqual(files[1], { ...result, size: generated.size, expires: generated.expires, canAsk: false });
  assert.deepEqual(files[2], { name: "tree.pdf", url: "drevo:tree-pdf:all", canAsk: false });
  assert.deepEqual(messages, saved);
  assert.deepEqual(researchLibraryFiles([{ role: "user", files: [{ name: "pending", url: "" }] }]), []);
});
