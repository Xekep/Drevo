import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPromise } from "yauzl";
import { openArchive } from "../src/server/database.ts";
import { portableExportHttp } from "../src/server/portable-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

test("portable export requires an archive administrator and streams a private package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-portable-http-"));
  const uploads = join(dir, "uploads");
  await mkdir(uploads);
  await writeFile(join(uploads, "portrait.png"), Buffer.from("photo bytes"));
  await writeFile(join(uploads, "record.pdf"), Buffer.from("%PDF-1.4\nrecord"));
  const archive = await openArchive(join(dir, "archive.sqlite"), {
    title: "Archive",
    description: "",
    demo: false,
    people: [
      {
        id: "p1",
        surname: "Иванов",
        name: "Пётр",
        patronymic: "",
        sex: "m",
        birth: "1880",
        birthPlace: "",
        parents: [],
        spouses: [],
        generation: 1,
        column: 0,
        sources: [],
        photo: "/media/portrait.png",
      },
    ],
    photos: [],
  });
  await archive.db
    .prepare(
      "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "d1",
      "Запись",
      "запись",
      "record.pdf",
      15,
      "owner",
      "2026-09-30",
      "Книга",
      "1880",
      "",
      "",
      "",
    );
  await archive.db
    .prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
    .run("d1", "p1");
  await archive.db
    .prepare(
      "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,?,?,?)",
    )
    .run("p1", "owner", 1000, "Проверено");
  let actor: ArchiveUser | null = {
    id: "owner",
    name: "Owner",
    role: "admin",
    createdAt: "",
  };
  const auth = {
    local: true,
    currentUser: () => actor,
  } as unknown as Awaited<ReturnType<typeof createAuth>>;
  const route = portableExportHttp(archive, auth, uploads);
  const server = createServer((req, res) => {
    void route(req, res, new URL(req.url!, "http://localhost"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/drevo/export`;
  try {
    const exported = await fetch(url);
    assert.equal(exported.status, 200);
    assert.match(
      exported.headers.get("content-disposition") || "",
      /drevo\.drevo/,
    );
    assert.equal(exported.headers.get("cache-control"), "no-store");
    const bytes = Buffer.from(await exported.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    const path = join(dir, "download.drevo");
    await writeFile(path, bytes);
    const zip = await openPromise(path);
    let data: {
      family: { people: Array<{ id: string }> };
      documents: Array<{ personIds: string[] }>;
      comments: Array<{ text: string }>;
    } | null = null;
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== "archive.json") continue;
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(Buffer.from(chunk));
      data = JSON.parse(Buffer.concat(chunks).toString());
    }
    assert.equal(data?.family.people[0].id, "p1");
    assert.deepEqual(data?.documents[0].personIds, ["p1"]);
    assert.equal(data?.comments[0].text, "Проверено");
    actor = { ...actor!, role: "reader" };
    assert.equal((await fetch(url)).status, 403);
    actor = null;
    assert.equal((await fetch(url)).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await archive.close();
    await rm(dir, { recursive: true, force: true });
  }
});
