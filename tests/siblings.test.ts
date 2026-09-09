import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  analyzeKinship,
  connectPeople,
  archiveConnections,
  replaceConnection,
  archiveChanges,
  applyArchiveChanges,
  inverseChanges,
  SIBLING_LINK_TYPES,
  validateFamily,
  suggestConnectionOrder,
  type Family,
  type Person,
} from "../src/domain/index.ts";
import { analysisExport } from "../src/domain/analysis-export.ts";
import { openArchive } from "../src/server/database.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { routeRelationships } from "../src/domain/edge-routing.ts";

const p = (
  id: string,
  sex: Person["sex"] = "m",
  parents: string[] = [],
  birth = "",
): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex,
  parents,
  birth,
  birthPlace: "",
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
  createdBy: "r",
});
const family = (...people: Person[]): Family => ({
  title: "Тест",
  description: "",
  demo: false,
  people,
});
const relation = (f: Family, a = "a", b = "b") =>
  analyzeKinship(
    f.people.find((p) => p.id === a)!,
    f.people.find((p) => p.id === b)!,
    f.people,
    f.links,
  );

test("direct sibling types work in both directions with no invented parents", () => {
  const words = [
    "брат",
    "родной брат",
    "единокровный брат",
    "единоутробный брат",
    "сводный брат",
  ];
  for (const [i, type] of SIBLING_LINK_TYPES.entries()) {
    const f = connectPeople(
      family(p("a"), p("b", "f")),
      "a",
      "b",
      type,
      "По семейной записи",
    );
    assert.equal(relation(f).roles?.[0].term, words[i]);
    assert.equal(relation(f, "b", "a").roles?.[1].term, words[i]);
    assert.equal(
      relation(f).kind,
      type === "step_sibling" ? "family" : "blood",
    );
    assert.deepEqual(
      f.people.map((p) => p.parents),
      [[], []],
    );
    assert.deepEqual(relation(f).common, []);
    assert.match(relation(f).explanation, /семейной записи/);
    assert.equal(analysisExport(f, 1, "test").links[0].type, type);
  }
  const f = connectPeople(
    family(p("a", "u"), p("b", "u")),
    "a",
    "b",
    "sibling",
  );
  assert.equal(relation(f).roles?.[0].term, "брат / сестра");
});

test("one blood sibling bridge determines nieces and cousins, without transitive half siblings", () => {
  let f = connectPeople(
    family(
      p("a"),
      p("b", "f"),
      p("child-a", "m", ["a"]),
      p("child-b", "f", ["b"]),
      p("c"),
    ),
    "a",
    "b",
    "sibling",
  );
  assert.equal(relation(f, "a", "child-b").roles?.[0].term, "дядя");
  assert.equal(relation(f, "a", "child-b").roles?.[1].term, "племянница");
  assert.equal(
    relation(f, "child-a", "child-b").roles?.[0].term,
    "двоюродный брат",
  );
  assert.deepEqual(relation(f, "child-a", "child-b").path, [
    "child-a",
    "a",
    "b",
    "child-b",
  ]);
  f = connectPeople(f, "b", "c", "maternal_sibling");
  assert.notEqual(relation(f, "a", "c").kind, "blood");
  const step = connectPeople(
    family(p("a"), p("b"), p("child-b", "m", ["b"])),
    "a",
    "b",
    "step_sibling",
  );
  assert.notEqual(relation(step, "a", "child-b").kind, "blood");
});

test("explicit full siblings refine incomplete parent data while automatic full siblings stay precise", () => {
  const f = connectPeople(
    family(p("a", "m", ["father"]), p("b", "f", ["father"]), p("father")),
    "a",
    "b",
    "full_sibling",
  );
  assert.equal(relation(f).roles?.[0].term, "родной брат");
  const known = connectPeople(
    family(
      p("a", "m", ["father", "mother"]),
      p("b", "f", ["father", "mother"]),
      p("father"),
      p("mother", "f"),
    ),
    "a",
    "b",
    "sibling",
  );
  assert.equal(relation(known).roles?.[0].term, "родной брат");
});

test("server validation rejects duplicate, contradictory and ancestor sibling links", () => {
  const f = connectPeople(family(p("a"), p("b")), "a", "b", "sibling");
  assert.throws(
    () => connectPeople(f, "b", "a", "full_sibling"),
    /уже существует/,
  );
  assert.throws(() => connectPeople(f, "a", "a", "sibling"));
  assert.throws(() => connectPeople(f, "a", "b", "parent"), /предок/);
  const known = family(
    p("a", "m", ["f", "m"]),
    p("b", "f", ["f", "m"]),
    p("f"),
    p("m", "f"),
  );
  for (const type of [
    "step_sibling",
    "paternal_sibling",
    "maternal_sibling",
  ] as const)
    assert.throws(() => connectPeople(known, "a", "b", type), /противоречит/);
  const different = family(
    p("a", "m", ["f"]),
    p("b", "f", ["f2"]),
    p("f"),
    p("f2"),
  );
  assert.throws(
    () => connectPeople(different, "a", "b", "full_sibling"),
    /противоречит/,
  );
  assert.doesNotThrow(() =>
    connectPeople(different, "a", "b", "maternal_sibling"),
  );
  const raw = structuredClone(f);
  raw.people[1].parents = ["a"];
  assert.throws(() => validateFamily(raw), /предок/);
});

test("sibling editing keeps identity, supports undo and enforces both owners", () => {
  const actor = {
    id: "r",
    name: "R",
    role: "relative" as const,
    createdAt: "",
  };
  const original = family(p("a"), p("b"));
  const f = authorizeArchive(
    connectPeople(original, "a", "b", "sibling"),
    original,
    actor,
  );
  const next = replaceConnection(f, archiveConnections(f)[0], {
    from: "b",
    to: "a",
    type: "full_sibling",
    note: "Уточнено",
  });
  assert.equal(next.links![0].id, f.links![0].id);
  assert.equal(next.links![0].createdBy, "r");
  assert.deepEqual(
    applyArchiveChanges(next, inverseChanges(archiveChanges(f, next))),
    { family: f, conflicts: [] },
  );
  assert.doesNotThrow(() => authorizeArchive(next, f, actor));
  const other = structuredClone(original);
  other.people[1].createdBy = "other";
  assert.throws(() =>
    authorizeArchive(connectPeople(other, "a", "b", "sibling"), other, actor),
  );
  assert.throws(() =>
    authorizeArchive(f, original, { ...actor, role: "reader" }),
  );
});

test("legacy SQLite migration preserves all data and accepts new types after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-siblings-")),
    file = join(dir, "archive.sqlite");
  let store = openArchive(file, family(p("a"), p("b"), p("c")));
  try {
    const initial = store.read();
    const f = connectPeople(initial.family, "a", "c", "godparent", "Источник");
    f.links![0].createdBy = "r";
    const saved = store.write(f, initial.revision);
    store.close();
    const legacy = new DatabaseSync(file);
    legacy.exec(`ALTER TABLE relations RENAME TO old_relations;
      CREATE TABLE relations (id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES people(id), target TEXT NOT NULL REFERENCES people(id), type TEXT NOT NULL CHECK(type IN ('parent','spouse','adoptive_parent','godparent','nurse','sworn_sibling','guardian')), note TEXT NOT NULL DEFAULT '', created_by TEXT) STRICT;
      INSERT INTO relations SELECT * FROM old_relations; DROP TABLE old_relations;`);
    legacy.close();
    store = openArchive(file, family());
    assert.deepEqual(store.read(), saved);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    const changed = store.write(
      connectPeople(saved.family, "a", "b", "full_sibling"),
      saved.revision,
    );
    store.close();
    store = openArchive(file, family());
    assert.deepEqual(store.read(), changed);
    assert.equal(relation(store.read().family).roles?.[0].term, "родной брат");
    assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM history").get()!.n);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sibling edges use side handles without changing parent data", () => {
  const people = [p("a"), p("b")];
  for (const type of SIBLING_LINK_TYPES) {
    const routes = routeRelationships(
      people,
      [{ from: "a", to: "b", type }],
      [
        ["a", { x: 0, y: 0 }],
        ["b", { x: 400, y: 0 }],
      ],
      180,
      90,
    );
    assert.equal(routes[0][1].sourceHandle, "right");
    assert.equal(routes[0][1].targetHandle, "left");
  }
});

test("initial parent direction uses non-overlapping date ranges and preserves other relation types", () => {
  const people = [p("a", "m", [], "2000-05-03"), p("b", "f", [], "1970")];
  const draft = { from: "a", to: "b", type: "parent" as const };
  const ordered = suggestConnectionOrder(draft, people);
  assert.equal(ordered.from, "b");
  assert.equal(ordered.to, "a");
  assert.match(ordered.hint!, /датам рождения/);
  assert.deepEqual(draft, { from: "a", to: "b", type: "parent" });
  for (const type of ["spouse", "sibling", "godparent"] as const) {
    const other = { ...draft, type };
    assert.equal(suggestConnectionOrder(other, people), other);
  }
  for (const [a, b] of [
    ["", "1970"],
    ["1970", "1970-06-01"],
    ["1970-06", "1970-06-03"],
    ["1970-06-03", "1970-06-03"],
  ]) {
    assert.deepEqual(
      suggestConnectionOrder(draft, [p("a", "m", [], a), p("b", "m", [], b)]),
      draft,
    );
  }
  assert.equal(
    suggestConnectionOrder(draft, [
      p("a", "m", [], "1970-06-04"),
      p("b", "m", [], "1970-06-03"),
    ]).from,
    "b",
  );
});
