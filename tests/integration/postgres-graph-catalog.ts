import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type pg from "pg";
import { archiveChanges } from "../../src/domain/changes.ts";
import type { Family, Source } from "../../src/domain/types.ts";
import { changePostgresGraphForSession } from "../../src/server/postgres-graph-changes.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";
import { fixture, fingerprint, person, tokens } from "./postgres-fixture.ts";

const documentId = "11111111-1111-4111-8111-111111111111";
const otherDocumentId = "22222222-2222-4222-8222-222222222222";
const citation = (catalogId: string, linkedDocumentId?: string): Source => ({
  catalogId, title: "Registry", type: "archive", reference: "leaf 4",
  ...(linkedDocumentId ? { documentId: linkedDocumentId, documentPage: 2 } : {}),
});
const inline = (url?: string): Source => ({
  title: "Family letter", type: "document", reference: "page 1",
  ...(url ? { url } : {}),
});
const newcomer = (sources: Source[] = []) => ({
  ...person("new", "1990"), createdBy: undefined, sources,
});

async function installCatalog(client: pg.Client) {
  await client.query(readFileSync(new URL("../../ops/postgres/048_source_catalog.sql", import.meta.url), "utf8"));
}

async function insertCatalog(client: pg.Client, archiveId: string, id: string, documentIds: string[]) {
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
  await client.query(`INSERT INTO source_catalog(archive_id,id,data,version)
    VALUES($1,$2,$3::jsonb,1)`, [archiveId, id, JSON.stringify({
    id, title: "Registry", type: "archive", author: "", institution: "",
    archive: "", fond: "", opis: "", delo: "", sheet: "", reference: "leaf 4",
    url: "", accessedAt: "", description: "", documentIds,
  })]);
}

async function addNewPerson(client: pg.Client, mutate: (family: Family) => Family) {
  const { family: before, revision } = await readPostgresArchive(client, "tree-a");
  return changePostgresGraphForSession(client, tokens.admin, "tree-a",
    archiveChanges(before, mutate(before)), revision);
}

test("raw graph accepts local catalog/document evidence across a person, claim, event and link", async (t) => {
  const { first } = await fixture(t);
  await installCatalog(first);
  await first.query(`INSERT INTO documents
    (archive_id,id,ordinal,title,title_search,file_name,file_size,uploaded_by,created_at)
    VALUES('tree-a',$1,1,'Record','record','record.pdf',10,'admin','2026-01-01')`, [documentId]);
  await insertCatalog(first, "tree-a", "local-register", [documentId]);
  const linked = citation("local-register", documentId);
  const legacyInline = { ...inline(), documentId };
  const result = await addNewPerson(first, (before) => ({
    ...before,
    people: [...before.people, {
      ...newcomer([linked, inline("https://example.org/letter"), legacyInline]),
      birthDateClaim: { value: "1990", sources: [linked] },
      events: [{ id: "move", type: "move", date: "2010", place: "Village",
        sources: [linked], dateClaim: { value: "2010", sources: [linked] },
        placeClaim: { value: "Village", sources: [linked] } }],
    }],
    links: [...before.links || [], { id: "link-new", from: "father", to: "new",
      type: "guardian", sources: [linked] }],
  }));
  assert.equal(result.revision, 1);
  const saved = (await readPostgresArchive(first, "tree-a")).family;
  assert.deepEqual(saved.people.find((item) => item.id === "new")?.sources,
    [linked, inline("https://example.org/letter"), legacyInline]);
  assert.deepEqual(saved.people.find((item) => item.id === "new")?.events?.[0].sources, [linked]);
  assert.deepEqual(saved.people.find((item) => item.id === "new")?.birthDateClaim?.sources, [linked]);
  assert.deepEqual(saved.links?.find((item) => item.id === "link-new")?.sources, [linked]);
});

test("raw graph rejects foreign, missing and unlinked catalog documents without a partial write", async (t) => {
  const { first } = await fixture(t);
  await installCatalog(first);
  await insertCatalog(first, "tree-a", "local-register", [documentId]);
  await insertCatalog(first, "tree-b", "foreign-register", [documentId]);
  const before = await fingerprint(first);
  const invalid = [
    { label: "missing", source: citation("missing-register") },
    { label: "foreign", source: citation("foreign-register") },
    { label: "document mismatch", source: citation("local-register", otherDocumentId) },
  ];
  for (const item of invalid) {
    await assert.rejects(addNewPerson(first, (family) => ({
      ...family, people: [...family.people, newcomer([item.source])],
    })), /Источник отсутствует в этом архиве|Документ цитаты отсутствует у источника/, item.label);
    assert.deepEqual(await fingerprint(first), before, item.label);
  }
});

test("raw graph checks nested event and claim citations plus link sources", async (t) => {
  const { first } = await fixture(t);
  await installCatalog(first);
  const missing = citation("missing-register");
  const variants: Array<[string, (family: Family) => Family]> = [
    ["birth claim", (family) => ({ ...family, people: [...family.people, {
      ...newcomer(), birthDateClaim: { value: "1990", sources: [missing] },
    }] })],
    ["event evidence", (family) => ({ ...family, people: [...family.people, {
      ...newcomer(), events: [{ id: "move", type: "move", date: "2010", sources: [missing] }],
    }] })],
    ["event place claim", (family) => ({ ...family, people: [...family.people, {
      ...newcomer(), events: [{ id: "move", type: "move", place: "Village",
        placeClaim: { value: "Village", sources: [missing] } }],
    }] })],
    ["link evidence", (family) => ({ ...family, links: [...family.links || [], {
      id: "new-link", from: "father", to: "child", type: "guardian", sources: [missing],
    }] })],
  ];
  const before = await fingerprint(first);
  for (const [label, mutate] of variants) {
    await assert.rejects(addNewPerson(first, mutate), /Источник отсутствует в этом архиве/, label);
    assert.deepEqual(await fingerprint(first), before, label);
  }
});

test("raw graph rejects new private citation media but retains an existing reference and external URL", async (t) => {
  const { first } = await fixture(t);
  const before = await fingerprint(first);
  await assert.rejects(addNewPerson(first, (family) => ({
    ...family, people: [...family.people, newcomer([inline("/media/new.pdf")])],
  })), /Новые медиацитаты не поддерживаются/, "new private media must not bypass quota");
  assert.deepEqual(await fingerprint(first), before);

  const retained = inline("/media/retained.pdf");
  await first.query(`UPDATE people SET data=jsonb_set(data,'{sources}',$1::jsonb)
    WHERE archive_id='tree-a' AND id='father'`, [JSON.stringify([retained])]);
  const result = await addNewPerson(first, (family) => ({
    ...family, people: [...family.people, newcomer([retained, inline("https://example.org/letter")])],
  }));
  assert.equal(result.revision, 1);
  assert.deepEqual((await readPostgresArchive(first, "tree-a")).family.people
    .find((item) => item.id === "new")?.sources, [retained, inline("https://example.org/letter")]);
});
