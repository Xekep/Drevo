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
  const metadata = encodeURIComponent(
    JSON.stringify({ title: "Семейная запись", personIds: ["anna"] }),
  );
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
    const pdf = await samplePdf();
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
    const list = (await (await fetch(`${base}/api/documents`)).json()) as {
      total: number;
      items: Array<{
        id: string;
        title: string;
        people: Array<{ id: string; name: string }>;
      }>;
    };
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, id);
    assert.equal(list.items[0].title, "Семейная запись");
    assert.deepEqual(
      list.items[0].people.map((person) => person.id),
      ["anna"],
    );
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
    const file = await fetch(`${base}/api/documents/${id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);

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
      items: Array<{ id: string; url: string; people: Array<{ id: string }> }>;
    };
    assert.equal(after.items.length, 1);
    assert.notEqual(after.items[0].id, id);
    assert.deepEqual(
      after.items[0].people.map((person) => person.id),
      ["anna"],
    );
    assert.deepEqual(
      Buffer.from(await (await fetch(base + after.items[0].url)).arrayBuffer()),
      pdf,
    );
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
        people: ["anna", "hidden"].map((id) => ({
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
    }
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
    const hiddenFilter = (await (
      await request("/api/documents?personId=anna", "owner")
    ).json()) as { total: number };
    assert.equal(hiddenFilter.total, 0);
    assert.equal((await request(path, "owner", "DELETE")).status, 404);
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
          "SELECT count(*) AS n FROM audit_entries WHERE entity='document' AND entity_id=?",
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
