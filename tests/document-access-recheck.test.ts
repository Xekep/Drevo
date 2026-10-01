import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentsHttp } from "../src/server/documents-http.ts";
import { openArchive } from "../src/server/database.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { mediaStore } from "../src/server/media.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

test("document reads recheck revoked and narrowed access before responding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-document-access-"));
  const archive = await openArchive(":memory:", {
    title: "Test",
    description: "",
    demo: false,
    people: [],
  });
  const admin: ArchiveUser = {
    id: "owner",
    name: "Owner",
    role: "admin",
    approved: true,
    createdAt: "",
  };
  const scoped: ArchiveUser = {
    ...admin,
    role: "reader",
    treeAccess: "common_ancestors",
  };
  const documentId = randomUUID();
  const fileName = `${randomUUID()}.pdf`;
  writeFileSync(join(dir, fileName), "%PDF-1.4\n");
  await archive.db.prepare(
    "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(documentId, "Private document", "private document", fileName, 9, admin.id, new Date().toISOString());
  let users: Array<ArchiveUser | null> = [];
  const auth = {
    canRead: async () => true,
    canEdit: async () => true,
    currentUser: async () => users.shift() ?? null,
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const handler = documentsHttp({
    archive,
    auth,
    media: {} as ReturnType<typeof mediaStore>,
    uploadsDirectory: dir,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://localhost"))
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error) => { res.writeHead(500).end(String(error)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    users = [null];
    assert.equal((await fetch(`${base}/api/documents`)).status, 403);
    for (const path of [
      "/api/documents",
      `/api/documents/${documentId}`,
      `/api/documents/${documentId}/annotations`,
      `/api/documents/${documentId}/file`,
    ]) {
      const requests: Record<string, string>[] = path.endsWith("/file")
        ? [{}, { Range: "bytes=0-3" }, { Range: "bytes=1000-" }]
        : [{}];
      for (const headers of requests) {
        users = path.endsWith("/file") ? [admin, scoped] : [admin, admin, scoped];
        const response = await fetch(`${base}${path}`, { headers });
        assert.ok(response.status === 403 || response.status === 404, `${path}: ${response.status}`);
        assert.equal(response.headers.get("content-range"), null);
        assert.doesNotMatch(await response.text(), /Private document|%PDF/);
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await archive.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
