import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createAuth } from "../src/server/auth.ts";
import { openArchive } from "../src/server/database.ts";
import { documentsHttp } from "../src/server/documents-http.ts";
import { mediaStore } from "../src/server/media.ts";

test("document file is withheld when its catalogue entry is removed before delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-document-revoke-"));
  const uploads = join(directory, "uploads");
  await mkdir(uploads);
  const archive = await openArchive(join(directory, "archive.sqlite"), {
    title: "Archive", description: "", demo: false, people: [], photos: [],
  });
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const fileName = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.pdf";
  const bytes = Buffer.from("%PDF-1.4\nprivate document");
  await writeFile(join(uploads, fileName), bytes);
  await archive.db.prepare(
    "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(id, "Private", "private", fileName, bytes.length, "owner", "2026-10-02");
  let revokeBeforeDelivery = false;
  let checks = 0;
  const user = {
    id: "owner", name: "Owner", role: "admin" as const,
    approved: true, createdAt: "", treeAccess: "all" as const,
  };
  const auth = {
    canRead: () => true,
    currentUser: async () => {
      checks++;
      if (revokeBeforeDelivery && checks === 2)
        await archive.db.prepare("DELETE FROM documents WHERE id=?").run(id);
      return user;
    },
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const route = documentsHttp({
    archive, auth, media: mediaStore(uploads), uploadsDirectory: uploads,
  });
  const server = createServer((req, res) => {
    void route(req, res, new URL(req.url || "/", "http://localhost"))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/documents/${id}/file`;
  try {
    const allowed = await fetch(url);
    assert.equal(allowed.status, 200);
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), bytes);

    checks = 0;
    revokeBeforeDelivery = true;
    const denied = await fetch(url);
    assert.equal(denied.status, 404);
    assert.notEqual(await denied.text(), bytes.toString());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});
