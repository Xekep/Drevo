import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { startServer } from "../src/server/index.ts";
import type { Family } from "../src/domain/types.ts";
import type { DocumentDetails } from "../src/shared/document-details.ts";
import { writeDatabaseBackup } from "../src/server/backup.ts";
import { sampleTiff } from "./fixtures/tiff.ts";

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
        events: [{ id: "anna-move", type: "move", title: "Переезд", date: "1887", sources: [] }],
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
      eventLinks: [{ personId: "anna", eventId: "anna-move", page: 2 }],
      pages: [{ number: 2, description: "Запись о переезде" }],
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
          eventLinks: unknown[];
          pages: unknown[];
          sources: Array<{ title: string }>;
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
    assert.deepEqual(list.items[0].eventLinks,
      [{ personId: "anna", eventId: "anna-move", page: 2, personName: "Тестова Анна", eventTitle: "Переезд" }]);
    assert.deepEqual(list.items[0].pages,
      [{ number: 2, description: "Запись о переезде" }]);
    const direct = await withoutFullRead(() => fetch(`${base}/api/documents/${id}`));
    assert.equal(direct.status, 200);
    assert.deepEqual(await direct.json(), list.items[0]);
    const byTitle = (await (
      await withoutFullRead(() => fetch(`${base}/api/documents?q=${encodeURIComponent("семейная")}`))
    ).json()) as { total: number };
    const byPerson = (await (
      await withoutFullRead(() => fetch(`${base}/api/documents?q=${encodeURIComponent("тестова")}`))
    ).json()) as { total: number };
    const noMatch = (await (
      await withoutFullRead(() => fetch(`${base}/api/documents?q=missing`))
    ).json()) as { total: number };
    const unlinkedPerson = (await (
      await withoutFullRead(() => fetch(`${base}/api/documents?q=${encodeURIComponent("борис")}`))
    ).json()) as { total: number };
    assert.equal(byTitle.total, 1);
    assert.equal(byPerson.total, 1);
    assert.equal(noMatch.total, 0);
    assert.equal(unlinkedPerson.total, 0);
    const byProvenance = (await (
      await withoutFullRead(() => fetch(`${base}/api/documents?q=GASO`))
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
    const pagesEdit = () => fetch(`${base}/api/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pages: { expected: [{ number: 2, description: "Запись о переезде" }],
        next: [{ number: 2, description: "Архивная запись" }] } }),
    });
    assert.equal((await pagesEdit()).status, 200);
    assert.equal((await pagesEdit()).status, 409);
    const invalidEvent = await fetch(`${base}/api/documents/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventLinks: { expected: [{ personId: "anna", eventId: "anna-move", page: 2 }],
        next: [{ personId: "boris", eventId: "anna-move" }] } }),
    });
    assert.equal(invalidEvent.status, 400);
    const withCitation = await app.archive.read();
    withCitation.family.people[0].sources.push({ title: "Дело 104", type: "archive", reference: "Л. 2", documentId: id, documentPage: 2 });
    await app.archive.write(withCitation.family, withCitation.revision);
    const catalogCreated = await fetch(`${base}/api/sources`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Метрическая книга", documentIds: [id] }),
    });
    assert.equal(catalogCreated.status, 201, await catalogCreated.clone().text());
    const catalog = (await catalogCreated.json()) as { source: { id: string; title: string; version: number } };
    const citedSnapshot = await app.archive.read();
    const citedPerson = citedSnapshot.family.people[0];
    citedPerson.birthPlace = "Реж";
    citedPerson.death = "2000";
    citedPerson.deathPlace = "Екатеринбург";
    for (const [field, value] of [
      ["birthDateClaim", citedPerson.birth], ["deathDateClaim", citedPerson.death],
      ["birthPlaceClaim", citedPerson.birthPlace], ["deathPlaceClaim", citedPerson.deathPlace],
    ] as const)
      citedPerson[field] = { value, sources: [{ catalogId: catalog.source.id,
        title: catalog.source.title, type: "", reference: "", documentId: id, documentPage: 2 }] };
    citedPerson.maidenName = "Соколова";
    citedPerson.maidenNameClaim = { value: "Соколова", sources: [
      { title: "Фамилия по записи", type: "archive", reference: "", documentId: id },
    ] };
    citedPerson.occupation = "Учитель";
    citedPerson.occupationClaim = { value: "Учитель", sources: [
      { title: "Занятие по записи", type: "archive", reference: "", documentId: id },
    ] };
    citedPerson.factAlternatives = [{ id: "alternate-birth-place", field: "birthPlace",
      value: "Пермь", sources: [{ title: "Другое место по записи", type: "archive",
        reference: "", documentId: id }] }];
    citedPerson.events![0].dateClaim = { value: "1887", sources: [{
      catalogId: catalog.source.id, title: catalog.source.title, type: "",
      reference: "", documentId: id, documentPage: 2,
    }] };
    citedPerson.events![0].alternatives = [{ id: "alternate-move-date", field: "date",
      value: "1888", sources: [{ title: "Другая дата переезда", type: "archive",
        reference: "", documentId: id }] }];
    citedPerson.awards = [{ id: "award-anna", name: "Медаль за отвагу",
      source: { title: "Прежняя запись", url: "https://example.test/legacy" },
      sources: [{ catalogId: catalog.source.id, title: catalog.source.title,
        type: "", reference: "", documentId: id, documentPage: 2 },
      { title: "Наградное удостоверение", type: "archive", reference: "л. 3",
        documentId: id, documentPage: 3 }] }];
    citedSnapshot.family.unions = [{ id: "anna-boris", participants: ["anna", "boris"],
      type: "marriage", sources: [{ title: "Семейная запись", type: "archive", reference: "", documentId: id }],
      formation: { date: "1970", sources: [{ title: "Запись о браке", type: "archive", reference: "", documentId: id }] },
      divorce: { date: "1990", sources: [{ title: "Запись о разводе", type: "archive", reference: "", documentId: id }] },
    }];
    citedSnapshot.family.links = [{ id: "anna-guardian-boris", from: "anna", to: "boris",
      type: "guardian", sources: [{ title: "Опекунская запись", type: "archive",
        reference: "", documentId: id, documentPage: 2 }] }];
    await app.archive.write(citedSnapshot.family, citedSnapshot.revision);
    const sourced = (await (await fetch(`${base}/api/documents/${id}`)).json()) as {
      sources: Array<{ title: string; page: number; assertions: string[] }>;
    };
    const expectedSources = [
      ["Дело 104", 2, ["Карточка"]],
      ["Метрическая книга", 2, ["Дата рождения", "Дата смерти",
        "Место рождения", "Место смерти", "Награда: Медаль за отвагу",
        "Дата события: Переезд"]],
      ["Фамилия по записи", undefined, ["Фамилия при рождении"]],
      ["Занятие по записи", undefined, ["Занятие"]],
      ["Другое место по записи", undefined, ["Другое место рождения: Пермь"]],
      ["Наградное удостоверение", 3, ["Награда: Медаль за отвагу"]],
      ["Другая дата переезда", undefined, ["Другая дата события: 1888"]],
      ["Семейная запись", undefined, ["Брак"]],
      ["Запись о браке", undefined, ["Брак · образование"]],
      ["Запись о разводе", undefined, ["Брак · развод"]],
      ["Опекунская запись", 2, ["Опекун"]],
    ];
    const reverseSources = (sources: typeof sourced.sources) => sources.map((source) =>
      [source.title, source.page, source.assertions]);
    assert.deepEqual(reverseSources(sourced.sources), expectedSources);
    const sourcedList = (await (await fetch(`${base}/api/documents`)).json()) as {
      items: Array<{ sources: typeof sourced.sources }>;
    };
    assert.deepEqual(reverseSources(sourcedList.items[0].sources), expectedSources);
    const file = await withoutFullRead(() => fetch(`${base}/api/documents/${id}/file`));
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "application/pdf");
    assert.equal(file.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);

    for (const [range, start, end] of [
      ["bytes=0-63", 0, 63],
      ["bytes=-64", pdf.length - 64, pdf.length - 1],
      [`bytes=${pdf.length - 64}-`, pdf.length - 64, pdf.length - 1],
      [`bytes=${pdf.length - 64}-${pdf.length + 100}`, pdf.length - 64, pdf.length - 1],
    ] as const) {
      const part = await withoutFullRead(() => fetch(`${base}/api/documents/${id}/file`, {
        headers: { Range: range },
      }));
      assert.equal(part.status, 206);
      assert.equal(part.headers.get("content-range"), `bytes ${start}-${end}/${pdf.length}`);
      assert.equal(part.headers.get("content-length"), String(end - start + 1));
      assert.equal(part.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), pdf.subarray(start, end + 1));
    }
    const outside = await fetch(`${base}/api/documents/${id}/file`, {
      headers: { Range: `bytes=${pdf.length}-` },
    });
    assert.equal(outside.status, 416);
    assert.equal(outside.headers.get("content-range"), `bytes */${pdf.length}`);
    assert.equal((await outside.arrayBuffer()).byteLength, 0);
    const conditional = await fetch(`${base}/api/documents/${id}/file`, {
      headers: { Range: "bytes=0-63", "If-Range": '"old-version"' },
    });
    assert.equal(conditional.status, 200);
    assert.deepEqual(Buffer.from(await conditional.arrayBuffer()), pdf);

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
    const invalidDatabase = join(dir, "invalid-source-backup.sqlite");
    await writeDatabaseBackup(app.archive.db, invalidDatabase);
    const invalidCopy = new DatabaseSync(invalidDatabase);
    const missingDocument = "99999999-9999-4999-8999-999999999999";
    invalidCopy.prepare("INSERT INTO source_catalog(id,data,version) VALUES(?,?,1)").run(
      "88888888-8888-4888-8888-888888888888",
      JSON.stringify({ id: "88888888-8888-4888-8888-888888888888", title: "Битый источник",
        type: "", author: "", institution: "", archive: "", fond: "", opis: "",
        delo: "", sheet: "", reference: "", url: "", accessedAt: "", description: "",
        documentIds: [missingDocument] }),
    );
    invalidCopy.close();
    const invalidPreview = await fetch(`${base}/api/restore/preview`, {
      method: "POST", headers: { "X-Drevo-Restore": "1" },
      body: new Uint8Array(readFileSync(invalidDatabase)),
    });
    assert.equal(invalidPreview.status, 400,
      "preview rejects a catalog attachment to a document absent from the backup");
    const missingCatalogDatabase = join(dir, "missing-source-backup.sqlite");
    await writeDatabaseBackup(app.archive.db, missingCatalogDatabase);
    const missingCatalogCopy = new DatabaseSync(missingCatalogDatabase);
    missingCatalogCopy.prepare("DELETE FROM source_catalog WHERE id=?").run(catalog.source.id);
    missingCatalogCopy.close();
    const missingCatalogPreview = await fetch(`${base}/api/restore/preview`, {
      method: "POST", headers: { "X-Drevo-Restore": "1" },
      body: new Uint8Array(readFileSync(missingCatalogDatabase)),
    });
    assert.equal(missingCatalogPreview.status, 400,
      "preview rejects a citation whose catalog record is missing");
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
          eventLinks: unknown[];
          pages: unknown[];
          sources: Array<{ title: string }>;
        }
      >;
    };
    assert.equal(after.items.length, 1);
    assert.equal(after.items[0].provenance, "GASO F6 Op13 D105");
    assert.deepEqual(after.items[0].pages,
      [{ number: 2, description: "Архивная запись" }]);
    assert.equal(after.items[0].eventLinks.length, 1);
    assert.equal(after.items[0].sources[0].title, "Дело 104");
    assert.notEqual(after.items[0].id, id);
    const restoredFamily = (await app.archive.read()).family;
    const restoredPerson = restoredFamily.people.find((person) => person.id === "anna")!;
    for (const claim of [restoredPerson.birthDateClaim, restoredPerson.deathDateClaim,
      restoredPerson.birthPlaceClaim, restoredPerson.deathPlaceClaim]) {
      assert.equal(claim?.sources[0].catalogId, catalog.source.id);
      assert.equal(claim?.sources[0].documentId, after.items[0].id);
      assert.equal(claim?.sources[0].documentPage, 2);
    }
    const restoredEventDate = restoredPerson.events?.find((event) => event.id === "anna-move")?.dateClaim;
    assert.equal(restoredEventDate?.value, "1887");
    assert.equal(restoredEventDate?.sources[0].catalogId, catalog.source.id);
    assert.equal(restoredEventDate?.sources[0].documentId, after.items[0].id);
    assert.equal(restoredEventDate?.sources[0].documentPage, 2);
    for (const sources of [restoredFamily.unions?.[0].sources,
      restoredFamily.unions?.[0].formation?.sources,
      restoredFamily.unions?.[0].divorce?.sources])
      assert.equal(sources?.[0].documentId, after.items[0].id);
    const restoredCatalog = await fetch(`${base}/api/sources/${catalog.source.id}`);
    assert.equal(restoredCatalog.status, 200);
    const restoredSource = ((await restoredCatalog.json()) as {
      source: { documentIds: string[]; version: number; title: string }
    }).source;
    assert.deepEqual(restoredSource.documentIds, [after.items[0].id]);
    assert.ok(restoredSource.version > catalog.source.version);
    assert.equal((await fetch(`${base}/api/sources/${catalog.source.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: catalog.source.version, title: "Устаревшая правка" }),
    })).status, 409, "an old editor cannot overwrite a source restored from backup");
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

test("image documents keep their type, private bytes and deletion semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-image-documents-"));
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await app.archive.write({
      title: "Изображения документов",
      description: "",
      demo: false,
      people: [{
        id: "person", name: "Анна", surname: "Тестова", patronymic: "",
        sex: "f", birth: "1950", birthPlace: "", parents: [], spouses: [],
        sources: [], column: 0, generation: 1,
      }],
    }, (await app.archive.read()).revision);
    const metadata = `base64:${Buffer.from(JSON.stringify({
      title: "Скан метрической записи",
      personIds: ["person"],
    })).toString("base64")}`;
    const upload = (bytes: Buffer, mime: string) => fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": mime, "X-Document-Metadata": metadata },
      body: new Uint8Array(bytes).buffer,
    });
    const picture = sharp({ create: {
      width: 40, height: 30, channels: 3, background: "#e2decf",
    } });
    const samples = [
      { mime: "image/jpeg", extension: "jpg", bytes: await picture.clone().jpeg().toBuffer() },
      { mime: "image/png", extension: "png", bytes: await picture.clone().png().toBuffer() },
      { mime: "image/webp", extension: "webp", bytes: await picture.clone().webp().toBuffer() },
      { mime: "image/gif", extension: "gif", bytes: await picture.clone().gif().toBuffer() },
      // Padding remains part of the original and exercises the TIFF >20 MiB limit in uploads and restore.
      { mime: "image/tiff", extension: "tif", bytes: Buffer.concat([await sampleTiff(), Buffer.alloc(21 * 1024 * 1024)]) },
    ];
    assert.equal((await upload(samples[1].bytes, "image/jpeg")).status, 415);
    assert.equal((await upload(Buffer.from("not an image"), "image/png")).status, 415);
    assert.equal((await upload(samples[1].bytes, "image/tiff")).status, 415);
    assert.equal((await upload(Buffer.from("II*\0not a TIFF"), "image/tiff")).status, 415);
    for (const { mime, extension, bytes } of samples) {
      const created = await upload(bytes, mime);
      assert.equal(created.status, 201, await created.clone().text());
      const { id } = (await created.json()) as { id: string };
      const listed = await fetch(`${base}/api/documents/${id}`);
      assert.equal(listed.status, 200);
      assert.equal(((await listed.json()) as { mimeType: string }).mimeType, mime);
      const file = await fetch(`${base}/api/documents/${id}/file`);
      assert.equal(file.headers.get("content-type"), mime);
      assert.equal(file.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      assert.ok(existsSync(join(dir, "uploads", `${id}.${extension}`)));
      if (extension === "tif") {
        const pages = await fetch(`${base}/api/documents/${id}/file?reader=pages`);
        assert.equal(pages.status, 200);
        assert.equal(pages.headers.get("cache-control"), "private, no-store");
        assert.deepEqual(await pages.json(), { pages: Array.from({ length: 3 }, () => ({ width: 40, height: 30 })) });
        for (let page = 1; page <= 3; page++) {
          const preview = await fetch(`${base}/api/documents/${id}/file?reader=page&page=${page}`);
          assert.equal(preview.status, 200);
          assert.equal(preview.headers.get("content-type"), "image/webp");
          assert.equal(preview.headers.get("cache-control"), "private, no-store");
          const { data, info } = await sharp(Buffer.from(await preview.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
          assert.equal(info.width, 40);
          assert.equal(info.height, 30);
          assert.ok(data[page - 1] > 245, `page ${page} retains its own pixels`);
          assert.ok(data[(page % 3)] < 10);
        }
        for (const page of ["0", "4", "1.5", "-1", "no", "2001"]) {
          assert.equal((await fetch(`${base}/api/documents/${id}/file?reader=page&page=${page}`)).status, 400);
        }
      }
      assert.equal((await fetch(`${base}/api/documents/${id}`, { method: "DELETE" })).status, 200);
      assert.equal(existsSync(join(dir, "uploads", `${id}.${extension}`)), false);
      assert.equal((await fetch(`${base}/api/documents/${id}/file`)).status, 404);
    }
    const scan = await upload(samples[1].bytes, samples[1].mime);
    assert.equal(scan.status, 201);
    const originalId = String(((await scan.json()) as { id: string }).id);
    const backup = Buffer.from(await (await fetch(`${base}/api/backup/full`)).arrayBuffer());
    const preview = await fetch(`${base}/api/restore/preview`, {
      method: "POST",
      headers: { "X-Drevo-Restore": "1" },
      body: backup,
    });
    assert.equal(preview.status, 200, await preview.clone().text());
    const { token, documents } = (await preview.json()) as { token: string; documents: number };
    assert.equal(documents, 1);
    const applied = await fetch(`${base}/api/restore/apply`, {
      method: "POST",
      headers: { "X-Drevo-Restore": "1" },
      body: JSON.stringify({ token, confirm: true }),
    });
    assert.equal(applied.status, 200, await applied.clone().text());
    const after = (await (await fetch(`${base}/api/documents`)).json()) as {
      items: Array<{ id: string; mimeType: string }>;
    };
    assert.equal(after.items.length, 1);
    assert.notEqual(after.items[0].id, originalId);
    assert.equal(after.items[0].mimeType, "image/png");
    const restoredFile = await fetch(`${base}/api/documents/${after.items[0].id}/file`);
    assert.equal(restoredFile.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await restoredFile.arrayBuffer()), samples[1].bytes);
    const tiff = samples[4];
    assert.equal((await upload(tiff.bytes, "image/x-tiff")).status, 201);
    const tiffBackup = Buffer.from(await (await fetch(`${base}/api/backup/full`)).arrayBuffer());
    const tiffPreview = await fetch(`${base}/api/restore/preview`, {
      method: "POST", headers: { "X-Drevo-Restore": "1" }, body: tiffBackup,
    });
    assert.equal(tiffPreview.status, 200, await tiffPreview.clone().text());
    const tiffToken = (await tiffPreview.json()).token;
    assert.equal((await fetch(`${base}/api/restore/apply`, {
      method: "POST", headers: { "X-Drevo-Restore": "1" },
      body: JSON.stringify({ token: tiffToken, confirm: true }),
    })).status, 200);
    const restored = (await (await fetch(`${base}/api/documents`)).json()).items.find(
      (item: { mimeType: string }) => item.mimeType === "image/tiff",
    );
    assert.ok(restored);
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/documents/${restored.id}/file`)).arrayBuffer()), tiff.bytes);
    assert.equal((await (await fetch(`${base}/api/documents/${restored.id}/file?reader=pages`)).json()).pages.length, 3);
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
        people: ["anna", "hidden", "outsider", "partner"].map((id) => ({
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
          events: [{ id: `${id}-event`, type: "move" as const, title: `${id} moved` }],
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
    const eventLinks = await fetch(base + path, {
      method: "PATCH",
      headers: { Cookie: cookies.get("owner")!, Origin: "https://archive.test", "Content-Type": "application/json" },
      body: JSON.stringify({ eventLinks: { expected: [], next: [
        { personId: "anna", eventId: "anna-event", page: 1 },
        { personId: "hidden", eventId: "hidden-event", page: 2 },
      ] } }),
    });
    assert.equal(eventLinks.status, 200, await eventLinks.clone().text());
    const cited = await app.archive.read();
    cited.family.people[0].birthDateClaim = { value: "1950", sources: [
      { title: "Visible birth record", type: "archive", reference: "", documentId: id },
    ] };
    cited.family.people[1].birthDateClaim = { value: "1950", sources: [
      { title: "Hidden birth record", type: "archive", reference: "", documentId: id },
    ] };
    cited.family.people[3].birthDateClaim = { value: "1950", sources: [
      { title: "Partner birth record", type: "archive", reference: "", documentId: id },
    ] };
    // A union partner of the anchor belongs to the blood-family scope. Keep
    // genuinely hidden citations on a different couple, without a union to Anna.
    cited.family.unions = [{ id: "hidden-outsider-union", participants: ["hidden", "outsider"],
      type: "marriage", sources: [{ title: "Hidden union record", type: "archive",
        reference: "", documentId: id }] },
      { id: "anna-partner-union", participants: ["anna", "partner"],
        type: "partnership", sources: [{ title: "Partner union record", type: "archive",
          reference: "", documentId: id }] }];
    cited.family.links = [{ id: "anna-hidden-link", from: "anna", to: "hidden",
      type: "guardian", sources: [{ title: "Hidden link record", type: "archive",
        reference: "", documentId: id }] }];
    await app.archive.write(cited.family, cited.revision);
    const adminSources = (await (await request(path, "admin")).json()) as {
      sources: Array<{ title: string }>;
    };
    assert.ok(adminSources.sources.some((source) => source.title === "Hidden birth record"));
    assert.ok(adminSources.sources.some((source) => source.title === "Hidden union record"));
    assert.ok(adminSources.sources.some((source) => source.title === "Hidden link record"));
    assert.ok(adminSources.sources.some((source) => source.title === "Partner union record"));
    await db
      .prepare(
        "UPDATE users SET person_id='anna',tree_access='common_ancestors' WHERE id='owner'",
      )
      .run();
    const scopedFamily = (await (await request("/api/family", "owner")).json()).family as Family;
    assert.deepEqual(scopedFamily.people.map((person) => person.id), ["anna", "partner"]);
    assert.deepEqual(scopedFamily.people.find((person) => person.id === "anna")!.spouses, [],
      "the union record alone grants the one-hop partner visibility");
    const scopedDocument = (await (await request(path, "owner")).json()) as {
      eventLinks: Array<{ personId: string }>;
      sources: Array<{ title: string; personName: string }>;
    };
    assert.deepEqual(scopedDocument.eventLinks.map((link) => link.personId), ["anna"]);
    assert.deepEqual(scopedDocument.sources.map((source) => source.title), [
      "Visible birth record", "Partner birth record", "Partner union record",
    ]);
    assert.ok(scopedDocument.sources.every((source) => !source.personName.includes("hidden")));
    const scopedList = (await (await request("/api/documents", "owner")).json()) as {
      items: Array<{ sources: typeof scopedDocument.sources }>;
    };
    assert.deepEqual(scopedList.items[0].sources, scopedDocument.sources);
    const afterCitations = await app.archive.read();
    for (const person of afterCitations.family.people) person.birthDateClaim = undefined;
    afterCitations.family.unions = [];
    afterCitations.family.links = [];
    await app.archive.write(afterCitations.family, afterCitations.revision);
    const removeVisibleEvent = await fetch(base + path, {
      method: "PATCH",
      headers: { Cookie: cookies.get("owner")!, Origin: "https://archive.test", "Content-Type": "application/json" },
      body: JSON.stringify({ eventLinks: { expected: [{ personId: "anna", eventId: "anna-event", page: 1 }], next: [] } }),
    });
    assert.equal(removeVisibleEvent.status, 200, await removeVisibleEvent.clone().text());
    assert.equal((await db.prepare("SELECT event_links FROM documents WHERE id=?").get(id))?.event_links,
      JSON.stringify([{ personId: "hidden", eventId: "hidden-event", page: 2 }]));
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
    assert.equal((await fetch(base + path, {
      method: "PATCH",
      headers: { Cookie: cookies.get("owner")!, Origin: "https://archive.test", "Content-Type": "application/json" },
      body: JSON.stringify({ eventLinks: { expected: [{ personId: "hidden", eventId: "hidden-event", page: 2 }], next: [] } }),
    })).status, 200);
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
        "Content-Type": "image/tiff",
        "X-Document-Metadata": encodeURIComponent(
          JSON.stringify({ title: "Без привязки", personIds: [] }),
        ),
      },
      body: new Uint8Array(await sampleTiff()).buffer,
    });
    assert.equal(scopedUnlinked.status, 201);
    const unlinkedPath = `/api/documents/${(await scopedUnlinked.json()).id}`;
    for (const suffix of ["", "/file", "/annotations", "/file?reader=pages", "/file?reader=page&page=2"])
      assert.equal((await request(unlinkedPath + suffix, "owner")).status, 200);
    const ownLibrary = await (await request("/api/documents", "owner")).json();
    assert.equal(ownLibrary.total, 1);
    await db
      .prepare(
        "UPDATE users SET person_id='outsider',tree_access='common_ancestors' WHERE id='other'",
      )
      .run();
    for (const suffix of ["", "/file", "/annotations", "/file?reader=pages", "/file?reader=page&page=2"])
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
