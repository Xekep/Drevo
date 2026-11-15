import test from "node:test";
import assert from "node:assert/strict";
import { researchLibraryFiles } from "../src/domain/research-library-files.ts";

test("chat library includes uploads and assistant downloads without inventing file sizes", () => {
  const upload = { name: "input.csv", url: "/api/ai/attachments/chat/input", size: 512, type: "text/csv" };
  const messages = [
    { role: "user", attachments: [upload] },
    { role: "assistant", files: [
      { name: "result.xlsx", url: "/api/ai/files/chat/result" },
      { name: "tree.pdf", url: "drevo:tree-pdf:all" },
      { name: "input.csv", url: upload.url },
    ] },
  ];
  const saved = structuredClone(messages), files = researchLibraryFiles(messages);
  assert.equal(files.length, 3);
  assert.deepEqual(files[0], upload);
  assert.equal(files[1].name, "result.xlsx");
  assert.equal(files[1].size, undefined);
  assert.equal(files[2].url, "drevo:tree-pdf:all");
  assert.deepEqual(messages, saved);
  assert.deepEqual(researchLibraryFiles([{ role: "user", files: [{ name: "pending", url: "" }] }]), []);
});
