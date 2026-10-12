import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { documentsHttp } from "../src/server/documents-http.ts";
import { openArchive } from "../src/server/database.ts";
import { PdfDecodeBusyError } from "../src/server/pdf-decode-coordinator.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { mediaStore } from "../src/server/media.ts";

test("a busy PDF decoder returns a retryable 503 without pretending the existing original was deleted", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "drevo-document-preparation-"),
  );
  const archive = await openArchive(":memory:", {
    title: "Synthetic",
    description: "",
    demo: false,
    people: [],
  });
  const id = randomUUID();
  const name = `${id}.pdf`;
  await writeFile(join(directory, name), "%PDF-1.4\n");
  await archive.db
    .prepare(
      "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      "Test PDF",
      "test pdf",
      name,
      9,
      "owner",
      new Date().toISOString(),
    );
  const auth = {
    local: true,
    canRead: async () => true,
    canEdit: async () => true,
    currentUser: async () => ({
      id: "owner",
      name: "Owner",
      role: "admin",
      approved: true,
      createdAt: "",
    }),
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const pdfPages = Object.assign(
    async () => {
      throw new PdfDecodeBusyError();
    },
    { close: async () => {} },
  );
  const handler = documentsHttp({
    archive,
    auth,
    uploadsDirectory: directory,
    media: {} as ReturnType<typeof mediaStore>,
    pdfPages,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://localhost")).catch(
      () => res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/api/documents/${id}/file?reader=pages`,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "2");
    assert.doesNotMatch(await response.text(), /не найден/);
    assert.ok(
      await archive.db.prepare("SELECT 1 FROM documents WHERE id=?").get(id),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handler.close();
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});
