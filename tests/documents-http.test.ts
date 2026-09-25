import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
    people: [{
      id: "anna", name: "Анна", surname: "Тестова", patronymic: "",
      sex: "f", birth: "1950", birthPlace: "", parents: [], spouses: [],
      sources: [], column: 0, generation: 1,
    }],
  };
  const metadata = encodeURIComponent(JSON.stringify({ title: "Семейная запись", personIds: ["anna"] }));
  const upload = (body: Buffer, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Document-Metadata": metadata, ...extra },
      body: new Uint8Array(body).buffer,
    });
  try {
    app.archive.write(family, app.archive.read().revision);
    assert.equal((await fetch(`${base}/api/documents`)).status, 200);
    assert.equal((await upload(Buffer.from("not a pdf"))).status, 415);
    assert.deepEqual(readdirSync(join(dir, "uploads")), []);
    const pdf = await samplePdf();
    assert.equal((await upload(pdf, { "X-Document-Metadata": encodeURIComponent(JSON.stringify({
      title: "Чужая запись", personIds: ["missing"],
    })) })).status, 403);
    const created = await upload(pdf);
    assert.equal(created.status, 201, await created.clone().text());
    const { id } = await created.json() as { id: string };
    const list = await (await fetch(`${base}/api/documents`)).json() as {
      total: number;
      items: Array<{ id: string; title: string; people: Array<{ id: string; name: string }> }>;
    };
    assert.equal(list.total, 1);
    assert.equal(list.items[0].id, id);
    assert.equal(list.items[0].title, "Семейная запись");
    assert.deepEqual(list.items[0].people.map((person) => person.id), ["anna"]);
    const byTitle = await (await fetch(`${base}/api/documents?q=${encodeURIComponent("семейная")}`)).json() as { total: number };
    const byPerson = await (await fetch(`${base}/api/documents?q=${encodeURIComponent("тестова")}`)).json() as { total: number };
    const noMatch = await (await fetch(`${base}/api/documents?q=missing`)).json() as { total: number };
    assert.equal(byTitle.total, 1);
    assert.equal(byPerson.total, 1);
    assert.equal(noMatch.total, 0);
    const file = await fetch(`${base}/api/documents/${id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);

    const backup = Buffer.from(await (await fetch(`${base}/api/backup/full`)).arrayBuffer());
    const preview = await fetch(`${base}/api/restore/preview`, {
      method: "POST", headers: { "X-Drevo-Restore": "1" }, body: backup,
    });
    assert.equal(preview.status, 200, await preview.clone().text());
    const { token, documents } = await preview.json() as { token: string; documents: number };
    assert.equal(documents, 1);
    const restored = await fetch(`${base}/api/restore/apply`, {
      method: "POST", headers: { "X-Drevo-Restore": "1" },
      body: JSON.stringify({ token, confirm: true }),
    });
    assert.equal(restored.status, 200, await restored.clone().text());
    const after = await (await fetch(`${base}/api/documents`)).json() as {
      items: Array<{ id: string; url: string; people: Array<{ id: string }> }>;
    };
    assert.equal(after.items.length, 1);
    assert.notEqual(after.items[0].id, id);
    assert.deepEqual(after.items[0].people.map((person) => person.id), ["anna"]);
    assert.deepEqual(Buffer.from(await (await fetch(base + after.items[0].url)).arrayBuffer()), pdf);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
