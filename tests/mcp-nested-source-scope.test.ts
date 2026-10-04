import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { sourceCatalogStore } from "../src/server/source-catalog-store.ts";
import type { Family, Person, Source } from "../src/domain/types.ts";
import type { CatalogSource } from "../src/shared/source-catalog.ts";

const documentId = "11111111-1111-4111-8111-111111111111";
const hiddenSource = (label: string): Source => ({
  title: `PRIVATE_NESTED_TITLE_${label}`,
  type: "archive",
  reference: `PRIVATE_NESTED_REFERENCE_${label}`,
  url: `https://private.example.test/${label}`,
  note: `PRIVATE_NESTED_NOTE_${label}`,
  repository: {
    name: `PRIVATE_REPOSITORY_${label}`,
    callNumber: "PRIVATE_CALL_NUMBER",
    website: "https://private.example.test/repository",
    note: "PRIVATE_REPOSITORY_NOTE",
    linkNote: "PRIVATE_LINK_NOTE",
  },
  documentId,
  documentPage: 7,
});
const catalogHiddenSource: Source = {
  catalogId: "private-nested-catalog",
  title: "PRIVATE_NESTED_TITLE_catalog",
  type: "archive",
  reference: "PRIVATE_NESTED_REFERENCE_catalog",
  documentId,
  documentPage: 9,
};

const catalog: CatalogSource = {
  id: "private-nested-catalog",
  title: "Synthetic nested catalogue",
  type: "archive",
  author: "",
  institution: "",
  archive: "",
  fond: "",
  opis: "",
  delo: "",
  sheet: "",
  reference: "",
  url: "",
  accessedAt: "",
  description: "",
  documentIds: [documentId],
};

const parent: Person = {
  id: "scope-parent",
  surname: "SyntheticParent",
  name: "Ada",
  patronymic: "",
  sex: "f",
  birth: "1870",
  birthDateClaim: { value: "1870", sources: [hiddenSource("parent-birth")],
    confidence: "confirmed" },
  birthPlace: "Old Town",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
};

const child: Person = {
  id: "scope-child",
  surname: "SyntheticChild",
  name: "Bea",
  patronymic: "",
  sex: "f",
  birth: "1900",
  death: "1980",
  birthPlace: "North Town",
  deathPlace: "South Town",
  occupation: "Archivist",
  maidenName: "Former",
  birthDateClaim: { value: "1900", sources: [hiddenSource("birth-date"), catalogHiddenSource],
    confidence: "probable" },
  deathDateClaim: { value: "1980", sources: [hiddenSource("death-date")] },
  birthPlaceClaim: { value: "North Town", sources: [hiddenSource("birth-place")] },
  deathPlaceClaim: { value: "South Town", sources: [hiddenSource("death-place")] },
  occupationClaim: { value: "Archivist", sources: [hiddenSource("occupation")] },
  maidenNameClaim: { value: "Former", sources: [hiddenSource("maiden")] },
  factAlternatives: [
    { id: "alternate-birth", field: "birth", value: "1901",
      sources: [hiddenSource("person-alternative")], confidence: "conflicting" },
    { id: "alternate-place", field: "birthPlace", value: "East Town",
      sources: [hiddenSource("place-alternative")] },
  ],
  events: [{
    id: "scope-event",
    type: "move",
    title: "Moved to Hall",
    date: "1920",
    place: "Hall",
    sources: [{ title: "Allowed event source", type: "archive", reference: "E-1" }],
    dateClaim: { value: "1920", sources: [hiddenSource("event-date")],
      confidence: "confirmed" },
    placeClaim: { value: "Hall", sources: [hiddenSource("event-place")] },
    alternatives: [
      { id: "alternate-event-date", field: "date", value: "1921",
        sources: [hiddenSource("event-alternative")], confidence: "tentative" },
    ],
  }],
  awards: [{ id: "scope-award", name: "Synthetic Medal", year: "1940",
    source: { title: "Allowed award source", url: "https://public.example.test/award" } }],
  parents: [parent.id],
  spouses: [],
  generation: 2,
  column: 0,
  sources: [{ title: "Allowed card source", type: "archive", reference: "C-1" }],
};

// The current family JSON accepts unknown nested fields. This also catches a
// future ParentClaim when its schema becomes part of the canonical domain.
(child as Person & { parentClaims?: unknown[] }).parentClaims = [{
  parentId: parent.id, sources: [hiddenSource("parent-claim")],
  confidence: "probable",
}];

function assertNoNestedSource(result: Record<string, unknown>) {
  const structured = JSON.stringify(result.structuredContent);
  const text = String((result.content as Array<{ text: string }>)[0].text);
  for (const output of [structured, text]) {
    assert.doesNotMatch(output, /PRIVATE_NESTED_|PRIVATE_REPOSITORY|PRIVATE_CALL_NUMBER|PRIVATE_LINK_NOTE/);
    assert.doesNotMatch(output, /private\.example\.test|private-nested-catalog/);
    assert.doesNotMatch(output, /11111111-1111-4111-8111-111111111111|"documentPage":7/);
  }
}

test("MCP tree and analysis tools retain facts but never reveal nested citations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-mcp-nested-scope-"));
  const app = await startServer(0, join(dir, "drevo.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await sourceCatalogStore(app.archive.db).insert(catalog);
    const current = await app.archive.read();
    const family: Family = {
      ...current.family,
      people: [...current.family.people, parent, child],
      photos: [...(current.family.photos || []), {
        id: "scope-photo", url: "/media/scope-photo.png",
        title: "Synthetic Photo Marker", year: "1910", place: "Synthetic Photo Place",
        tags: [{ id: "scope-photo-tag", personId: child.id,
          x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
      }],
    };
    await app.archive.write(family, current.revision);
    const stored = await app.archive.read();
    const storedChild = stored.family.people.find((person) => person.id === child.id) as
      (Person & { parentClaims?: Array<{ sources: Source[] }> }) | undefined;
    assert.equal(storedChild?.parentClaims?.[0].sources[0].title,
      "PRIVATE_NESTED_TITLE_parent-claim");

    const issue = async (scopes: string[]) => {
      const response = await fetch(`${base}/api/mcp/tokens`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `Synthetic ${scopes.join("+")}`,
          scopes, rateLimitPerMinute: 100 }),
      });
      assert.equal(response.status, 201);
      return (await response.json() as { token: string }).token;
    };
    const treeToken = await issue(["tree:read"]);
    const analysisToken = await issue(["analysis:read"]);
    const analysisSourcesToken = await issue(["analysis:read", "sources:read"]);
    const sourceToken = await issue(["sources:read"]);
    let id = 0;
    const call = async (token: string, name: string, args: Record<string, unknown>,
      modern: boolean) => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(modern ? { "MCP-Protocol-Version": "2026-07-28" } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call",
          params: { name, arguments: args } }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { result: Record<string, unknown> };
      assert.equal(body.result.isError, undefined, `${name}: ${JSON.stringify(body)}`);
      return body.result;
    };

    for (const modern of [false, true]) {
      const personResult = await call(treeToken, "get_person", { personId: child.id }, modern);
      assertNoNestedSource(personResult);
      const personData = (personResult.structuredContent as { person: Person }).person;
      assert.equal(personData.birth, "1900");
      assert.equal(personData.birthDateClaim?.value, "1900");
      assert.equal(personData.birthDateClaim?.confidence, "probable");
      assert.equal(personData.factAlternatives?.[0].value, "1901");
      assert.equal(personData.factAlternatives?.[0].confidence, "conflicting");
      assert.equal(personData.events?.[0].dateClaim?.confidence, "confirmed");

      const familyResult = await call(treeToken, "get_family", { personId: child.id }, modern);
      assertNoNestedSource(familyResult);
      const familyData = familyResult.structuredContent as { parents: Person[] };
      assert.equal(familyData.parents[0].birthDateClaim?.value, "1870");
      assert.equal(familyData.parents[0].birthDateClaim?.confidence, "confirmed");

      const timelineResult = await call(analysisToken, "get_timeline",
        { personId: child.id }, modern);
      assertNoNestedSource(timelineResult);
      const timeline = timelineResult.structuredContent as { items: Array<{ event?: { date?: string } }> };
      assert.ok(timeline.items.some((item) => item.event?.date === "1920"));

      const archiveResult = await call(analysisToken, "search_archive",
        { query: "Moved to Hall" }, modern);
      assertNoNestedSource(archiveResult);
      const archiveMatches = archiveResult.structuredContent as {
        matches: Array<{ event?: { title?: string } }>;
      };
      assert.ok(archiveMatches.matches.some((match) => match.event?.title === "Moved to Hall"));

      for (const query of ["Allowed card source", "Synthetic Photo Marker"]) {
        const withoutSources = await call(analysisToken, "search_archive", { query }, modern);
        assert.deepEqual((withoutSources.structuredContent as { matches: unknown[] }).matches, []);
        assert.equal((withoutSources.structuredContent as { total: number }).total, 0);
        const withSources = await call(analysisSourcesToken, "search_archive", { query }, modern);
        const matches = (withSources.structuredContent as {
          matches: Array<{ kind: string }>;
        }).matches;
        assert.equal(matches.length, 1);
        assert.equal(matches[0].kind, query === "Allowed card source" ? "source" : "photo");
      }
      const timelineWithSources = await call(analysisSourcesToken, "get_timeline",
        { personId: child.id }, modern);
      assert.equal(timeline.items.some((item) => (item as { kind?: string }).kind === "photo"), false);
      assert.ok((timelineWithSources.structuredContent as {
        items: Array<{ kind: string }>;
      }).items.some((item) => item.kind === "photo"));

      const photoPlaceWithoutSources = await call(analysisToken, "get_place_summary",
        { query: "Synthetic Photo Place" }, modern);
      assert.deepEqual((photoPlaceWithoutSources.structuredContent as {
        matches: unknown[];
      }).matches, []);
      const photoPlaceWithSources = await call(analysisSourcesToken, "get_place_summary",
        { query: "Synthetic Photo Place" }, modern);
      assert.equal((photoPlaceWithSources.structuredContent as {
        matches: Array<{ kind: string }>;
      }).matches[0].kind, "photo");

      const denied = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${treeToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call",
          params: { name: "get_sources", arguments: { personId: child.id } } }),
      }).then((response) => response.json()) as { result: { isError: boolean } };
      assert.equal(denied.result.isError, true);

      const sourcesResult = await call(sourceToken, "get_sources", { personId: child.id }, modern);
      const sources = sourcesResult.structuredContent as {
        card: Source[]; events: Array<{ sources: Source[] }>;
        awards: Array<{ source: { title: string } }>;
      };
      assert.equal(sources.card[0].title, "Allowed card source");
      assert.equal(sources.events[0].sources[0].title, "Allowed event source");
      assert.equal(sources.awards[0].source.title, "Allowed award source");
    }

    // Pause after the archive snapshot, at the final delivery transaction.
    // A token narrowed while the result is prepared must not deliver the
    // previously computed source result.
    const originalRead = app.archive.read;
    const originalTransaction = app.archive.db.transaction;
    let entered!: () => void, release!: () => void;
    const finalStarted = new Promise<void>((resolve) => { entered = resolve; });
    const finalAllowed = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    let barrierTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      app.archive.read = async () => {
        const snapshot = await originalRead();
        app.archive.db.transaction = async <T>(work: () => Promise<T>, readOnly?: boolean) => {
          app.archive.db.transaction = originalTransaction;
          entered();
          await finalAllowed;
          return originalTransaction(work, readOnly);
        };
        return snapshot;
      };
      const pending = fetch(`${base}/mcp`, {
        method: "POST", signal: controller.signal,
        headers: { Authorization: `Bearer ${analysisSourcesToken}`,
          "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call",
          params: { name: "search_archive", arguments: { query: "Allowed card source" } } }),
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        barrierTimeout = setTimeout(() =>
          reject(new Error("MCP final-delivery barrier not reached")), 5000);
      });
      await Promise.race([finalStarted, deadline]);
      clearTimeout(barrierTimeout);
      barrierTimeout = undefined;
      await app.archive.db.prepare("UPDATE mcp_tokens SET scopes=? WHERE token_hash=?")
        .run(JSON.stringify(["analysis:read"]),
          createHash("sha256").update(analysisSourcesToken).digest("hex"));
      release();
      const revoked = await pending;
      assert.equal(revoked.status, 403);
      const revokedBody = await revoked.text();
      assert.doesNotMatch(revokedBody, /Allowed card source|structuredContent/);
    } finally {
      if (barrierTimeout) clearTimeout(barrierTimeout);
      release();
      controller.abort();
      app.archive.read = originalRead;
      app.archive.db.transaction = originalTransaction;
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
