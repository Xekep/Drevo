import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { Person } from "../src/domain/types.ts";
import type { DocumentAnnotation } from "../src/shared/document-annotations.ts";

test("document comments show the linked full name only within the reader's archive scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-annotation-authors-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const db = app.archive.db;
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const person = (id: string, name: string): Person => ({
      id, name, surname: "Тестов", patronymic: "Иванович", sex: "m",
      birth: "1950", birthPlace: "", parents: [], spouses: [], sources: [],
      column: 0, generation: 1,
    });
    await app.archive.write({ title: "Тест", description: "", demo: false,
      people: [person("anchor", "Антон"), person("hidden", "Борис"),
        { ...person("visible-author", "Сергей"), parents: ["anchor"] }] },
    (await app.archive.read()).revision);
    const cookies = new Map<string, string>();
    for (const [index, [id, role, personId, scope]] of [
      ["author", "relative", "hidden", "all"],
      ["reader", "reader", "anchor", "common_ancestors"],
      ["unlinked", "relative", null, "all"],
    ].entries()) {
      await db.prepare("INSERT INTO users(id,name,role,approved,person_id,tree_access) VALUES(?,?,?,1,?,?)")
        .run(id, `Login ${id}`, role, personId, scope);
      const token = String(index + 1).repeat(64);
      await db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
        .run(createHash("sha256").update(token).digest("hex"), id, Date.now() + 60_000);
      cookies.set(id!, `drevo_session=${token}`);
    }
    const documentId = randomUUID();
    const annotation: DocumentAnnotation = {
      id: randomUUID(), page: 1, x: 0.1, y: 0.1, width: 0.1, height: 0.1,
      text: "Old comment", authorId: "author", authorName: "Login author",
      createdAt: new Date().toISOString(),
    };
    await db.prepare(`INSERT INTO documents(id,title,title_search,file_name,file_size,
      uploaded_by,created_at,annotations) VALUES(?,?,?,?,?,?,?,?)`).run(
      documentId, "Документ", "документ", `${documentId}.pdf`, 1, "author",
      new Date().toISOString(), JSON.stringify([annotation]));
    await db.prepare("INSERT INTO document_people(document_id,person_id) VALUES(?,?)")
      .run(documentId, "anchor");
    const path = `${base}/api/documents/${documentId}/annotations`;
    const list = async (user: string, prefix = "") => {
      const response = await fetch(`${base}${prefix}/api/documents/${documentId}/annotations`,
        { headers: { Cookie: cookies.get(user)! } });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).items as DocumentAnnotation[];
    };
    const originalRead = app.archive.read;
    app.archive.read = async () => { throw new Error("Unrestricted annotation reads must not load the entire graph"); };
    try {
      assert.equal((await list("author"))[0].authorName, "Тестов Борис Иванович");
    } finally {
      app.archive.read = originalRead;
    }
    assert.equal((await list("reader"))[0].authorName, "Login author", "hidden profile name is not disclosed");
    const posted = await fetch(path, { method: "POST", headers: {
      Cookie: cookies.get("author")!, Origin: "https://archive.test", "Content-Type": "application/json",
    }, body: JSON.stringify({ page: 1, x: 0.2, y: 0.2, width: 0.1, height: 0.1, text: "New comment" }) });
    assert.equal(posted.status, 201, await posted.clone().text());
    assert.equal((await posted.json()).items[1].authorName, "Тестов Борис Иванович");
    assert.equal((await list("reader"))[1].authorName, "Login author");
    await db.prepare("UPDATE users SET person_id='visible-author' WHERE id='author'").run();
    assert.equal((await list("reader"))[0].authorName, "Тестов Сергей Иванович", "existing comments follow the current archive binding");
    await db.prepare("UPDATE users SET person_id=NULL WHERE id='author'").run();
    assert.equal((await list("unlinked"))[0].authorName, "Login author");
    await db.prepare("UPDATE documents SET annotations=? WHERE id=?").run(
      JSON.stringify([{ ...annotation, authorId: "deleted-account", authorName: "Удалённый участник" }]), documentId);
    assert.equal((await list("unlinked"))[0].authorName, "Удалённый участник");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
  }
});
