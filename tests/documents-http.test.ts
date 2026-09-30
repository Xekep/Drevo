import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";
import type { DocumentDetails } from "../src/shared/document-details.ts";

async function samplePdf() {
  const pdf = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  for (let index = 1; index <= 3; index++) {
    pdf.addPage();
    pdf.text(`Page ${index}`);
  }
  pdf.end();
  return done;
}

test("uploaded PDFs are listed by person, served privately and survive a full backup restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-documents-"));
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const withoutFullRead = async <T>(work: () => Promise<T>) => {
    const originalRead = app.archive.read;
    app.archive.read = async () => {
      throw new Error("An unscoped document read must not load the full graph");
    };
    try {
      return await work();
    } finally {
      app.archive.read = originalRead;
    }
  };
  const family: Family = {
    title: "Документы",
    description: "",
    demo: false,
    people: [
      {
        id: "anna",
        name: "Анна",
        surname: "Тестова",
        patronymic: "",
        sex: "f",
        birth: "1950",
        birthPlace: "",
        parents: [],
        spouses: [],
        sources: [],
        column: 0,
        generation: 1,
      },
      {
        id: "boris",
        name: "Борис",
        surname: "Тестов",
        patronymic: "",
        sex: "m",
        birth: "1952",
        birthPlace: "",
        parents: [],
        spouses: [],
        sources: [],
        column: 1,
        generation: 1,
      },
    ],
  };
  const metadata = `base64:${Buffer.from(
    JSON.stringify({
      title: "Семейная запись",
      personIds: ["anna"],
      documentType: "metrical record",
      documentDate: "1887",
      place: "Rezh",
      description: "Register page 12",
      provenance: "GASO F6 Op13 D104",
    }),
    "utf8",
  ).toString("base64")}`;
  const upload = (body: Buffer, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Document-Metadata": metadata,
        ...extra,
      },
      body: new Uint8Array(body).buffer,
    });
  try {
    await app.archive.write(family, (await app.archive.read()).revision);
    assert.equal((await fetch(`${base}/api/documents`)).status, 200);
    assert.equal((await upload(Buffer.from("not a pdf"))).status, 415);
    assert.deepEqual(readdirSync(join(dir, "uploads")), []);
    const pdf = Buffer.alloc(21 * 1024 * 1024, 32);
    (await samplePdf()).copy(pdf);
    assert.equal(
      (
        await upload(pdf, {
          "X-Document-Metadata": encodeURIComponent(
            JSON.stringify({
              title: "Неверные сведения",
              personIds: ["anna"],
              documentType: 42,
            }),
          ),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await upload(pdf, {
          "X-Document-Metadata": encodeURIComponent(
            JSON.stringify({
              title: "Чужая запись",
              personIds: ["missing"],
            }),
          ),
        })
      ).status,
      403,
    );
    const created = await upload(pdf);
    assert.equal(created.status, 201, await created.clone().text());
    const { id } = (await created.json()) as { id: string };
    const listed = await withoutFullRead(() => fetch(`${base}/api/documents`));
    assert.equal(listed.status, 200, await listed.clone().text());
    const list = (await listed.json()) as {
      total: number;
      items: Array<
        DocumentDetails & {
          id: string;
          title: string;
          people: Array<{ id: string; name: string }>;
        }
      >;
    };
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, id);
    assert.equal(list.items[0].title, "Семейная запись");
    assert.equal(list.items[0].documentType, "metrical record");
    assert.equal(list.items[0].documentDate, "1887");
    assert.equal(list.items[0].place, "Rezh");
    assert.equal(list.items[0].description, "Register page 12");
    assert.equal(list.items[0].provenance, "GASO F6 Op13 D104");
    assert.deepEqual(
      list.items[0].people.map((person) => person.id),
      ["anna"],
    );
    assert.equal(list.items[0].people[0].name, "Тестова Анна");
    const direct = await withoutFullRead(() => fetch(`${base}/api/documents/${id}`));
    assert.equal(direct.status, 200);
    assert.deepEqual(await direct.json(), list.items[0]);
    const byTitle = (await (
      await fetch(`${base}/api/documents?q=${encodeURIComponent("семейная")}`)
    ).json()) as { total: number };
    const byPerson = (await (
      await fetch(`${base}/api/documents?q=${encodeURIComponent("тестова")}`)
    ).json()) as { total: number };
    const noMatch = (await (
      await fetch(`${base}/api/documents?q=missing`)
    ).json()) as { total: number };
    assert.equal(byTitle.total, 1);
    assert.equal(byPerson.total, 1);
    assert.equal(noMatch.total, 0);
    const byProvenance = (await (
      await fetch(`${base}/api/documents?q=GASO`)
    ).json()) as { total: number };
    assert.equal(byProvenance.total, 1);
    const expected = {
      title: list.items[0].title,
      documentType: list.items[0].documentType,
      documentDate: list.items[0].documentDate,
      place: list.items[0].place,
      description: list.items[0].description,
      provenance: list.items[0].provenance,
    };
    const next = { ...expected, provenance: "GASO F6 Op13 D105" };
    const edit = () =>
      fetch(`${base}/api/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected, next }),
      });
    assert.equal((await edit()).status, 200);
    assert.equal(
      (await edit()).status,
      409,
      "устаревшая правка не затирает новый текст",
    );
    assert.equal(
      (await (await fetch(`${base}/api/documents/${id}`)).json()).provenance,
      next.provenance,
    );
    const file = await withoutFullRead(() => fetch(`${base}/api/documents/${id}/file`));
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);

    const annotationUrl = `${base}/api/documents/${id}/annotations`;
    const selection = {
      page: 2,
      x: 0.15,
      y: 0.25,
      width: 0.3,
      height: 0.2,
      text: "Запись о рождении",
    };
    const comment = await fetch(annotationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...selection,
        authorName: "Подмена",
        canDelete: false,
      }),
    });
    assert.equal(comment.status, 201, await comment.clone().text());
    const saved = (await comment.json()) as {
      items: Array<{
        id: string;
        text: string;
        canDelete: boolean;
        authorName: string;
      }>;
    };
    assert.equal(saved.items[0].text, selection.text);
    assert.equal(saved.items[0].canDelete, true);
    assert.notEqual(saved.items[0].authorName, "Подмена");
    assert.equal(
      (
        await fetch(annotationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...selection, x: 0.9 }),
        })
      ).status,
      400,
    );
    assert.equal(
      ((await (await withoutFullRead(() => fetch(annotationUrl))).json()) as { items: unknown[] })
        .items.length,
      1,
    );

    const backup = Buffer.from(
      await (await fetch(`${base}/api/backup/full`)).arrayBuffer(),
    );
    const preview = await fetch(`${base}/api/restore/preview`, {
      method: "POST",
      headers: { "X-Drevo-Restore": "1" },
      body: backup,
    });
    assert.equal(preview.status, 200, await preview.clone().text());
    const { token, documents } = (await preview.json()) as {
      token: string;
      documents: number;
    };
    assert.equal(documents, 1);
    const restored = await fetch(`${base}/api/restore/apply`, {
      method: "POST",
      headers: { "X-Drevo-Restore": "1" },
      body: JSON.stringify({ token, confirm: true }),
    });
    assert.equal(restored.status, 200, await restored.clone().text());
    const after = (await (await fetch(`${base}/api/documents`)).json()) as {
      items: Array<
        DocumentDetails & {
          id: string;
          url: string;
          people: Array<{ id: string }>;
        }
      >;
    };
    assert.equal(after.items.length, 1);
    assert.equal(after.items[0].provenance, "GASO F6 Op13 D105");
    assert.notEqual(after.items[0].id, id);
    assert.deepEqual(
      after.items[0].people.map((person) => person.id),
      ["anna"],
    );
    assert.deepEqual(
      Buffer.from(await (await fetch(base + after.items[0].url)).arrayBuffer()),
      pdf,
    );
    const restoredAnnotations = (await (
      await fetch(`${base}/api/documents/${after.items[0].id}/annotations`)
    ).json()) as { items: Array<{ text: string }> };
    assert.equal(restoredAnnotations.items[0].text, selection.text);
    const other = await upload(pdf, {
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: "Запись Бориса", personIds: ["boris"] }),
      ),
    });
    assert.equal(other.status, 201);
    const annaDocuments = (await (
      await fetch(`${base}/api/documents?personId=anna`)
    ).json()) as { total: number; items: Array<{ title: string }> };
    const borisDocuments = (await (
      await fetch(`${base}/api/documents?personId=boris`)
    ).json()) as { total: number; items: Array<{ title: string }> };
    assert.deepEqual(
      annaDocuments.items.map((item) => item.title),
      ["Семейная запись"],
    );
    assert.deepEqual(
      borisDocuments.items.map((item) => item.title),
      ["Запись Бориса"],
    );
    assert.equal(annaDocuments.total, 1);
    assert.equal(borisDocuments.total, 1);
    assert.equal(
      (
        (await (
          await fetch(`${base}/api/documents?personId=unknown`)
        ).json()) as { total: number }
      ).total,
      0,
    );
    assert.equal((await fetch(`${base}/api/documents?personId=`)).status, 400);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("document deletion enforces ownership, scope and origin, removes files and records an atomic audit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-document-delete-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(0, join(directory, "archive.sqlite"), true);
    const db = app.archive.db;
    await app.archive.write(
      {
        title: "Test",
        description: "",
        demo: false,
        people: ["anna", "hidden", "outsider"].map((id) => ({
          id,
          name: id,
          surname: "Test",
          patronymic: "",
          sex: "f" as const,
          birth: "1950",
          birthPlace: "",
          parents: [],
          spouses: [],
          sources: [],
          column: 0,
          generation: 1,
        })),
      },
      (await app.archive.read()).revision,
    );
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const cookies = new Map<string, string>();
    for (const [index, [id, role]] of [
      ["admin", "admin"],
      ["owner", "relative"],
      ["other", "relative"],
      ["reader", "reader"],
    ].entries()) {
      await db
        .prepare("INSERT INTO users(id,name,role,approved) VALUES(?,?,?,1)")
        .run(id, id, role);
      const token = String(index + 1).repeat(64);
      await db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        )
        .run(
          createHash("sha256").update(token).digest("hex"),
          id,
          Date.now() + 60_000,
        );
      cookies.set(id, `drevo_session=${token}`);
    }
    const request = (
      path: string,
      user: string,
      method = "GET",
      origin = "https://archive.test",
    ) =>
      fetch(base + path, {
        method,
        headers: { Cookie: cookies.get(user) || "", Origin: origin },
      });
    const pdf = await samplePdf();
    const upload = async () => {
      const response = await fetch(base + "/api/documents", {
        method: "POST",
        headers: {
          Cookie: cookies.get("owner")!,
          Origin: "https://archive.test",
          "Content-Type": "application/pdf",
          "X-Document-Metadata": encodeURIComponent(
            JSON.stringify({ title: "Record", personIds: ["anna"] }),
          ),
        },
        body: new Uint8Array(pdf).buffer,
      });
      assert.equal(response.status, 201, await response.clone().text());
      return ((await response.json()) as { id: string }).id;
    };
    const id = await upload();
    const path = `/api/documents/${id}`;
    const edit = (user: string, origin = "https://archive.test") =>
      fetch(base + path, {
        method: "PATCH",
        headers: {
          Cookie: cookies.get(user) || "",
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expected: { title: "Record" },
          next: { title: "Record", provenance: "GASO" },
        }),
      });
    assert.equal((await edit("reader")).status, 403);
    assert.equal((await edit("other")).status, 403);
    assert.equal((await edit("owner", "https://evil.test")).status, 403);
    const linkPeople = (
      user: string,
      expected: unknown,
      next: unknown,
      origin = "https://archive.test",
      documentPath = path,
    ) =>
      fetch(base + documentPath, {
        method: "PATCH",
        headers: {
          Cookie: cookies.get(user) || "",
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ people: { expected, next } }),
      });
    assert.equal((await linkPeople("reader", ["anna"], [])).status, 403);
    assert.equal((await linkPeople("other", ["anna"], [])).status, 403);
    assert.equal(
      (await linkPeople("owner", ["anna"], [], "https://evil.test")).status,
      403,
    );
    assert.equal(
      (await linkPeople("owner", ["anna"], ["missing"])).status,
      403,
    );
    assert.equal(
      (await linkPeople("owner", ["anna"], ["anna", "anna"])).status,
      400,
    );
    assert.equal((await linkPeople("owner", "anna", [])).status, 400);
    const competing = await Promise.all([
      linkPeople("owner", ["anna"], ["anna", "hidden"]),
      linkPeople("owner", ["anna"], []),
    ]);
    assert.deepEqual(
      competing.map((response) => response.status).sort(),
      [200, 409],
    );
    const currentLinks = (
      await (await request(path, "owner")).json()
    ).people.map((person: { id: string }) => person.id);
    assert.equal(
      (await linkPeople("owner", currentLinks, ["anna", "hidden"])).status,
      200,
    );
    await db
      .prepare(
        "UPDATE users SET person_id='anna',tree_access='common_ancestors' WHERE id='owner'",
      )
      .run();
    assert.equal(
      (await linkPeople("owner", ["anna"], ["anna", "hidden"])).status,
      403,
    );
    const scopedLinks = await linkPeople("owner", ["anna"], []);
    assert.equal(scopedLinks.status, 200);
    assert.deepEqual((await scopedLinks.json()).people, []);
    assert.deepEqual(
      (
        await db
          .prepare("SELECT person_id FROM document_people WHERE document_id=?")
          .all(id)
      ).map((row) => row.person_id),
      ["hidden"],
    );
    assert.equal(
      (await request(path, "owner")).status,
      404,
      "own document linked only to hidden people stays inaccessible",
    );
    await db
      .prepare("UPDATE users SET tree_access='all' WHERE id='owner'")
      .run();
    assert.equal((await linkPeople("owner", ["hidden"], ["anna"])).status, 200);
    const annotationPath = `${path}/annotations`;
    const annotate = (user: string, origin = "https://archive.test") =>
      fetch(base + annotationPath, {
        method: "POST",
        headers: {
          Cookie: cookies.get(user) || "",
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.2,
          text: "Архивная пометка",
        }),
      });
    assert.equal((await annotate("reader")).status, 403);
    assert.equal((await annotate("owner", "https://evil.test")).status, 403);
    const annotation = await annotate("owner");
    assert.equal(annotation.status, 201);
    const annotationId = (
      (await annotation.json()) as { items: Array<{ id: string }> }
    ).items[0].id;
    assert.equal(
      (await request(`${annotationPath}/${annotationId}`, "other", "DELETE"))
        .status,
      403,
    );
    assert.equal(
      (await request(`${annotationPath}/${annotationId}`, "admin", "DELETE"))
        .status,
      200,
    );
    for (const [user, expected] of [
      ["owner", true],
      ["admin", true],
      ["other", false],
      ["reader", false],
    ] as const) {
      const list = (await (await request("/api/documents", user)).json()) as {
        items: Array<{ canDelete: boolean }>;
      };
      assert.equal(list.items[0].canDelete, expected);
      const direct = (await (await request(path, user)).json()) as {
        canDelete: boolean;
      };
      assert.equal(direct.canDelete, expected);
    }
    assert.equal((await request(path, "")).status, 401);
    assert.equal((await request(path, "", "DELETE")).status, 401);
    assert.equal((await request(path, "reader", "DELETE")).status, 403);
    assert.equal((await request(path, "other", "DELETE")).status, 403);
    assert.equal(
      (await request(path, "owner", "DELETE", "https://evil.test")).status,
      403,
    );
    await db
      .prepare(
        "UPDATE users SET person_id='hidden',tree_access='common_ancestors' WHERE id='owner'",
      )
      .run();
    const scopedUnlinked = await fetch(base + "/api/documents", {
      method: "POST",
      headers: {
        Cookie: cookies.get("owner")!,
        Origin: "https://archive.test",
        "Content-Type": "application/pdf",
        "X-Document-Metadata": encodeURIComponent(
          JSON.stringify({ title: "Без привязки", personIds: [] }),
        ),
      },
      body: new Uint8Array(pdf).buffer,
    });
    assert.equal(scopedUnlinked.status, 201);
    const unlinkedPath = `/api/documents/${(await scopedUnlinked.json()).id}`;
    for (const suffix of ["", "/file", "/annotations"])
      assert.equal((await request(unlinkedPath + suffix, "owner")).status, 200);
    const ownLibrary = await (await request("/api/documents", "owner")).json();
    assert.equal(ownLibrary.total, 1);
    await db
      .prepare(
        "UPDATE users SET person_id='outsider',tree_access='common_ancestors' WHERE id='other'",
      )
      .run();
    for (const suffix of ["", "/file", "/annotations"])
      assert.equal((await request(unlinkedPath + suffix, "other")).status, 404);
    assert.equal(
      (await (await request("/api/documents", "other")).json()).total,
      0,
    );
    assert.equal(
      (
        await linkPeople(
          "owner",
          [],
          ["anna"],
          "https://archive.test",
          unlinkedPath,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await linkPeople(
          "owner",
          [],
          ["hidden"],
          "https://archive.test",
          unlinkedPath,
        )
      ).status,
      200,
    );
    assert.equal((await request(unlinkedPath, "owner", "DELETE")).status, 200);
    await db
      .prepare("UPDATE users SET tree_access='all' WHERE id='other'")
      .run();
    const hiddenFilter = (await (
      await request("/api/documents?personId=anna", "owner")
    ).json()) as { total: number };
    assert.equal(hiddenFilter.total, 0);
    assert.equal((await request(path, "owner", "DELETE")).status, 404);
    assert.equal((await edit("owner")).status, 404);
    assert.equal((await request(path, "owner")).status, 404);
    assert.equal((await request(annotationPath, "owner")).status, 404);
    assert.equal((await annotate("owner")).status, 404);
    await db
      .prepare("UPDATE users SET tree_access='all' WHERE id='owner'")
      .run();
    await db.exec(
      "CREATE TRIGGER reject_document_audit BEFORE INSERT ON audit_entries WHEN NEW.entity='document' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
    );
    assert.equal((await request(path, "owner", "DELETE")).status, 500);
    assert.ok(await db.prepare("SELECT 1 FROM documents WHERE id=?").get(id));
    assert.ok(existsSync(join(directory, "uploads", `${id}.pdf`)));
    await db.exec("DROP TRIGGER reject_document_audit");
    const transaction = db.transaction;
    let revoked = false;
    db.transaction = async (work, readOnly = false) => {
      if (!readOnly && !revoked) {
        revoked = true;
        await db
          .prepare("UPDATE users SET role='reader' WHERE id='owner'")
          .run();
      }
      return transaction(work, readOnly);
    };
    try {
      assert.equal((await request(path, "owner", "DELETE")).status, 403);
      assert.equal(revoked, true);
      assert.ok(await db.prepare("SELECT 1 FROM documents WHERE id=?").get(id));
      assert.ok(existsSync(join(directory, "uploads", `${id}.pdf`)));
    } finally {
      db.transaction = transaction;
      await db
        .prepare("UPDATE users SET role='relative' WHERE id='owner'")
        .run();
    }
    // Both handlers reach the write boundary before either can delete. A
    // lookup outside the transaction would now let both report success.
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    db.transaction = async (work, readOnly = false) => {
      if (!readOnly) {
        if (++arrivals === 2) release();
        await ready;
      }
      return transaction(work, readOnly);
    };
    let results: Response[];
    try {
      results = await Promise.all([
        request(path, "owner", "DELETE"),
        request(path, "owner", "DELETE"),
      ]);
    } finally {
      release();
      db.transaction = transaction;
    }
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [200, 404],
    );
    assert.equal(existsSync(join(directory, "uploads", `${id}.pdf`)), false);
    assert.equal(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM document_people WHERE document_id=?",
        )
        .get(id))!.n,
      0,
    );
    assert.equal(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM audit_entries WHERE entity='document' AND entity_id=? AND action='Удалён документ'",
        )
        .get(id))!.n,
      1,
    );
    assert.equal((await request(path + "/file", "owner")).status, 404);
    const missing = await upload();
    unlinkSync(join(directory, "uploads", `${missing}.pdf`));
    assert.equal(
      (await request(`/api/documents/${missing}`, "admin", "DELETE")).status,
      200,
    );
  } finally {
    await app?.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    rmSync(directory, { recursive: true, force: true });
  }
});
