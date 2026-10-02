import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { openArchive } from "../src/server/database.ts";
import { portableImportHttp } from "../src/server/portable-import-http.ts";
import {
  writePortablePackage,
  type PortableSnapshot,
} from "../src/server/portable-package.ts";
import { userStore } from "../src/server/users.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import type { createAuth } from "../src/server/auth.ts";

test("existing SQLite workflow stages survive the portable-kind migration", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    db.exec(`
      DROP TABLE workflow_stages;
      CREATE TABLE workflow_stages (
        token TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('gedcom','restore')),
        actor_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        directory TEXT,
        UNIQUE(kind,actor_id)
      ) STRICT;
      INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data)
      VALUES('old','gedcom','owner',1,9999999999999,'{}');
    `);
    initializeArchiveSchema(db);
    assert.equal(
      db.prepare("SELECT token FROM workflow_stages WHERE kind='gedcom'").get()
        ?.token,
      "old",
    );
    db.prepare(
      "INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data) VALUES('new','drevo','owner',1,9999999999999,'{}')",
    ).run();
  } finally {
    db.close();
  }
});

test("concurrent portable previews for one owner return a conflict without leaking reservations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-concurrent-preview-"));
  const source = join(dir, "source");
  const target = join(dir, "target");
  await mkdir(source);
  await mkdir(target);
  const packagePath = join(dir, "archive.drevo");
  await writePortablePackage(createWriteStream(packagePath), source, {
    family: { title: "Archive", description: "", demo: false, people: [], photos: [] },
    documents: [], comments: [],
  }, async () => {});
  const bytes = await readFile(packagePath);
  const archivePath = join(target, "archive.sqlite");
  const archive = await openArchive(archivePath, {
    title: "Empty", description: "", demo: false, people: [], photos: [],
  });
  const owner = await (await userStore(archive.db, { requireInitialAdmin: false }))
    .register("owner", "Owner");
  const auth = { local: true, currentUser: async () => owner } as unknown as
    Awaited<ReturnType<typeof createAuth>>;
  let readers = 0;
  let releaseReaders!: () => void;
  const bothRead = new Promise<void>((resolve) => { releaseReaders = resolve; });
  const timeout = setTimeout(releaseReaders, 5000);
  const originalPrepare = archive.db.prepare.bind(archive.db);
  archive.db.prepare = (sqlite, postgres) => {
    const statement = originalPrepare(sqlite, postgres);
    if (!sqlite.startsWith("SELECT token,data FROM workflow_stages WHERE kind='drevo' AND actor_id=?"))
      return statement;
    return { ...statement, all: async (...values) => {
      const rows = await statement.all(...values);
      if (++readers === 2) releaseReaders();
      await bothRead;
      return rows;
    } };
  };
  const route = portableImportHttp(archive, auth, archivePath);
  const server = createServer((req, res) => {
    void route.handle(req, res, new URL(req.url!, `http://${req.headers.host}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const preview = () => fetch(`${base}/api/drevo/preview`, {
      method: "POST", headers: { Origin: base, "X-Drevo-Import": "1" }, body: bytes,
    });
    const responses = await Promise.all([preview(), preview()]);
    assert.equal(readers, 2, "both requests observed the empty stage table");
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    assert.equal((await conflict.json() as { error: string }).error, "Импорт уже выполняется");
    assert.equal((await archive.db.prepare(
      "SELECT count(*) AS n FROM workflow_stages WHERE kind='drevo'",
    ).get())?.n, 1);
    assert.equal((await archive.db.prepare(
      "SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests",
    ).get())?.bytes, 0);
    assert.equal((await readdir(join(target, "staging", "portable"))).length, 1);
  } finally {
    clearTimeout(timeout);
    archive.db.prepare = originalPrepare;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await route.close();
    await archive.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("private package preview and one-time import preserve people, media, documents and comments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-import-http-"));
  const source = join(dir, "source");
  const target = join(dir, "target");
  await mkdir(source);
  await mkdir(target);
  const image = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "white" },
  })
    .png()
    .toBuffer();
  const pdf = Buffer.from("%PDF-1.4\nrecord");
  await writeFile(join(source, "portrait.png"), image);
  await writeFile(join(source, "record.pdf"), pdf);
  const snapshot: PortableSnapshot = {
    family: {
      title: "Imported tree",
      description: "Evidence",
      demo: false,
      people: [
        {
          id: "p1",
          surname: "Test",
          name: "Person",
          patronymic: "",
          sex: "u",
          birth: "1880",
          birthPlace: "",
          parents: [],
          spouses: [],
          generation: 1,
          column: 0,
          sources: [],
          events: [{ id: "import-date", type: "move", date: "1901",
            dateClaim: { value: "1901", sources: [{ title: "Record",
              type: "архив", reference: "л. 1", catalogId: "imported-date-source",
              documentId: "12d254eb-5c3f-4b56-95e9-9c2788b17a64", documentPage: 1,
            }] } }],
          photo: "/media/portrait.png",
          createdBy: "remote",
        },
        {
          id: "p2", surname: "Test", name: "Other", patronymic: "",
          sex: "u", birth: "1881", birthPlace: "", parents: [], spouses: [],
          generation: 1, column: 1, sources: [],
        },
      ],
      photos: [{ id: "gallery", url: "/media/portrait.png", title: "Photo",
        tags: [], createdBy: "remote" }],
      links: [{ id: "link", from: "p1", to: "p2", type: "sworn_sibling",
        createdBy: "remote" }],
      unions: [{ id: "union", participants: ["p1", "p2"], type: "partnership",
        createdBy: "remote" }],
    },
    documents: [
      {
        id: "12d254eb-5c3f-4b56-95e9-9c2788b17a64",
        title: "Record",
        fileName: "record.pdf",
        uploadedBy: "remote",
        createdAt: "2026-09-30T00:00:00Z",
        documentType: "",
        documentDate: "",
        place: "",
        description: "",
        provenance: "",
        annotations: [{ id: "be1b574f-946f-41be-93a8-1e4c512f5b40", page: 1,
          x: 0.1, y: 0.1, width: 0.2, height: 0.2, text: "Note",
          authorId: "remote", authorName: "Historian",
          createdAt: "2026-09-30T00:00:00Z" }],
        personIds: ["p1"],
      },
    ],
    sources: [{ id: "imported-date-source", title: "Record", type: "архив",
      author: "", institution: "", archive: "", fond: "", opis: "", delo: "",
      sheet: "", reference: "л. 1", url: "", accessedAt: "", description: "",
      documentIds: ["12d254eb-5c3f-4b56-95e9-9c2788b17a64"] }],
    comments: [
      {
        id: 1,
        personId: "p1",
        authorId: "remote",
        authorName: "Historian",
        createdMs: 1000,
        text: "Verified",
      },
    ],
  };
  const packagePath = join(dir, "archive.drevo");
  await writePortablePackage(
    createWriteStream(packagePath),
    source,
    snapshot,
    async () => {},
  );
  const bytes = await readFile(packagePath);
  const path = join(target, "archive.sqlite");
  const archive = await openArchive(path, {
    title: "Empty",
    description: "",
    demo: false,
    people: [],
    photos: [],
  });
  const owner = await (
    await userStore(archive.db, { requireInitialAdmin: false })
  ).register("owner", "Owner");
  let actor = owner;
  const auth = {
    local: true,
    currentUser: async () => actor,
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const route = portableImportHttp(archive, auth, path);
  const server = createServer((req, res) => {
    void route.handle(
      req,
      res,
      new URL(req.url!, `http://${req.headers.host}`),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Origin: base, "X-Drevo-Import": "1" };
  try {
    const initialRevision = (await archive.read()).revision;
    const catalogData = JSON.stringify({
      id: "existing-source", title: "Existing source", type: "archive",
      author: "", institution: "", archive: "", fond: "", opis: "",
      delo: "", sheet: "", reference: "", url: "", accessedAt: "",
      description: "", documentIds: [],
    });
    await archive.db
      .prepare("INSERT INTO source_catalog(id,data,version) VALUES(?,?,1)")
      .run("existing-source", catalogData);
    actor = { ...owner, role: "reader" };
    const denied = await fetch(`${base}/api/drevo/preview`, {
      method: "POST",
      headers,
      body: Buffer.from("invalid archive"),
    });
    assert.equal(denied.status, 403, "a reader cannot probe whether the target archive is empty");
    actor = owner;
    const occupied = await fetch(`${base}/api/drevo/preview`, {
      method: "POST",
      headers,
      body: Buffer.from("invalid archive"),
    });
    assert.equal(occupied.status, 409, "catalog-only archives are not empty");
    assert.match((await occupied.json() as { error: string }).error, /только в пустое дерево/);
    assert.equal((await archive.read()).revision, initialRevision);
    assert.equal(
      (await archive.db.prepare("SELECT data FROM source_catalog WHERE id=?").get("existing-source"))?.data,
      catalogData,
    );
    assert.equal(
      (await archive.db.prepare("SELECT count(*) AS n FROM workflow_stages WHERE kind='drevo'").get())?.n,
      0,
    );
    assert.deepEqual(await readdir(join(target, "staging", "portable")), []);
    await archive.db.prepare("DELETE FROM source_catalog WHERE id=?").run("existing-source");
    assert.equal(
      (
        await fetch(`${base}/api/drevo/preview`, {
          method: "POST",
          headers,
          body: Buffer.from("invalid archive"),
        })
      ).status,
      400,
    );
    await writeFile(join(source, "record.pdf"), "not a pdf");
    const invalidPath = join(dir, "invalid.drevo");
    await writePortablePackage(
      createWriteStream(invalidPath),
      source,
      snapshot,
      async () => {},
    );
    await writeFile(join(source, "record.pdf"), pdf);
    const invalid = await fetch(`${base}/api/drevo/preview`, {
      method: "POST",
      headers,
      body: await readFile(invalidPath),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await archive.read()).family.people.length, 0);
    const chunked = await fetch(`${base}/api/drevo/preview`, {
      method: "POST",
      headers,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    assert.equal(chunked.status, 200);
    assert.equal(
      (
        await fetch(`${base}/api/drevo/preview`, {
          method: "POST",
          headers: { ...headers, Origin: "https://other.test" },
          body: bytes,
        })
      ).status,
      403,
    );
    const previewResponse = await fetch(`${base}/api/drevo/preview`, {
      method: "POST",
      headers,
      body: bytes,
    });
    assert.equal(
      previewResponse.status,
      200,
      previewResponse.status === 200 ? "" : await previewResponse.text(),
    );
    const preview = (await previewResponse.json()) as {
      token: string;
      people: number;
      documents: number;
    };
    assert.equal(preview.people, 2);
    assert.equal(preview.documents, 1);
    assert.equal((await archive.read()).family.people.length, 0);
    const importRequest = () =>
      fetch(`${base}/api/drevo/import`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ token: preview.token, confirm: true }),
      });
    await archive.db.exec(
      "CREATE TRIGGER reject_portable_document BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT,'reject'); END",
    );
    const failed = await importRequest();
    assert.equal(failed.status, 500);
    assert.deepEqual(await readdir(join(target, "uploads")), []);
    assert.equal(
      Number(
        (await archive.db.prepare("SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests").get())?.bytes,
      ),
      0,
      "failed portable import releases its disk reservation",
    );
    await archive.db.exec("DROP TRIGGER reject_portable_document");
    const applied = await importRequest();
    assert.equal(
      applied.status,
      200,
      applied.status === 200 ? "" : await applied.text(),
    );
    assert.equal(
      Number(
        (await archive.db.prepare("SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM document_upload_requests").get())?.bytes,
      ),
      0,
      "successful portable import releases its disk reservation",
    );
    const result = await archive.read();
    assert.equal(result.family.people.length, 2);
    assert.equal(result.family.people[0].createdBy, undefined);
    assert.equal(result.family.photos?.[0].createdBy, undefined);
    assert.equal(result.family.links?.[0].createdBy, undefined);
    assert.equal(result.family.unions?.[0].createdBy, undefined);
    const portrait = result.family.people[0].photo!;
    assert.notEqual(portrait, "/media/portrait.png");
    assert.deepEqual(
      await readFile(join(target, "uploads", portrait.slice(7))),
      image,
    );
    const document = await archive.db
      .prepare("SELECT id,file_name AS name,annotations FROM documents")
      .get();
    assert.ok(document);
    const importedCitation = result.family.people[0].events?.[0].dateClaim?.sources[0];
    assert.equal(result.family.people[0].events?.[0].dateClaim?.value, "1901");
    assert.equal(importedCitation?.documentId, document.id);
    assert.equal(importedCitation?.documentId,
      "12d254eb-5c3f-4b56-95e9-9c2788b17a64",
      "portable import keeps stable IDs in an empty archive");
    assert.equal(importedCitation?.documentPage, 1);
    assert.equal(importedCitation?.catalogId, "imported-date-source");
    assert.equal(JSON.parse(String(document.annotations))[0].authorId, "");
    assert.equal(JSON.parse(String(document.annotations))[0].authorName, "Historian");
    assert.deepEqual(
      await readFile(join(target, "uploads", String(document.name))),
      pdf,
    );
    const comment = await archive.db
      .prepare("SELECT author_id,author_name FROM person_comments")
      .get();
    assert.equal(comment?.author_id, "");
    assert.equal(comment?.author_name, "Historian");
    assert.equal((await importRequest()).status, 409);
    actor = { ...owner, role: "reader" };
    assert.equal((await importRequest()).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await route.close();
    await archive.close();
    await rm(dir, { recursive: true, force: true });
  }
});
