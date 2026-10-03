import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  analyzeKinship,
  createKinshipAnalyzer,
} from "../src/domain/kinship-analysis.ts";
import {
  createPersonRelationLabels,
  kinshipLabelKey,
  personRelationLabel,
} from "../src/components/tree/person-relation-label.ts";
import type { FamilyLink, FamilyUnion, Person } from "../src/domain/types.ts";
import {
  kinshipGraphs,
  kinshipPerson as person,
} from "./fixtures/kinship-graphs.ts";

test("prepared kinship preserves the complete legacy oracle for 3456 ordered pairs", () => {
  const records = [];
  for (const { people, links, unions } of kinshipGraphs()) {
    const prepared = createKinshipAnalyzer(people, links, unions);
    for (const a of people)
      for (const b of people) {
        const relation = prepared(a, b);
        assert.deepEqual(relation, analyzeKinship(a, b, people, links, unions));
        records.push(relation);
      }
  }
  // Generated with the unmodified kinship.ts + kinship-analysis.ts from a0ec7bf.
  // Includes every Relation field, role, alias, extra relation and ordered path.
  assert.equal(
    createHash("sha256").update(JSON.stringify(records)).digest("hex"),
    "b57806471bb0f1b0146f35fe39397ce4ecf4d2769934f0030fa6dea77dc3694e",
  );
});

test("incoming children and spouses retain their combined archive order at equal BFS distance", () => {
  const a = person("a", [], "m"),
    b = person("b", [], "f");
  const child = { ...person("child", ["a"], "m"), spouses: ["b"] };
  const spouse = { ...person("spouse", [], "f"), spouses: ["a", "b"] };
  assert.deepEqual(createKinshipAnalyzer([a, spouse, child, b])(a, b).path, [
    "a",
    "spouse",
    "b",
  ]);
  assert.deepEqual(createKinshipAnalyzer([a, child, spouse, b])(a, b).path, [
    "a",
    "child",
    "b",
  ]);
});

test("duplicate ids preserve the legacy first endpoint / last graph record behavior", () => {
  const father = person("father", [], "m"),
    mother = person("mother", [], "f");
  const first = { ...person("a", ["father"], "m"), name: "First" };
  const last = { ...person("a", ["mother"], "f"), name: "Second" };
  const b = person("b", ["mother"], "m");
  const people = [father, mother, first, last, b],
    analyze = createKinshipAnalyzer(people);
  const records = people.flatMap((a) => people.map((b) => analyze(a, b)));
  assert.equal(
    createHash("sha256").update(JSON.stringify(records)).digest("hex"),
    "a0cfc3629ff5d116af82ca0b0f1c92caaa71c5e4da9b98a621cdaebd9b8fe89f",
  );
  assert.deepEqual(analyze(first, b).common, ["mother"]);
  assert.equal(analyze(first, b).roles![0].term, "брат");
});

test("pedigree collapse, parent-order ties and cycles preserve direct ancestry and shortest paths", () => {
  const root = person("root"),
    x = person("x", ["root"]),
    y = person("y", ["root"]);
  const a = person("a", ["y", "x"]),
    b = person("b", ["x", "y"]);
  const prepared = createKinshipAnalyzer([root, x, y, a, b]);
  assert.deepEqual(prepared(a, b).common, ["y", "x"]);
  assert.deepEqual(prepared(a, b).path, ["a", "y", "b"]);
  assert.deepEqual(prepared(root, a).path, ["root", "y", "a"]);
  root.parents = ["a"];
  const cyclic = createKinshipAnalyzer([root, x, y, a, b]);
  assert.equal(cyclic(root, a).kind, "direct");
  assert.deepEqual(cyclic(root, a).common, []);
  assert.deepEqual(cyclic(root, a).path, ["root", "y", "a"]);
});

test("documented path ordering excludes presumed parent inference and preserves first step-parent", () => {
  const a = person("a"),
    b = person("b"),
    x = person("x"),
    y = person("y");
  const links: FamilyLink[] = [
    { id: "presumed", from: "a", to: "y", type: "presumed_parent" },
    { id: "yb", from: "y", to: "b", type: "guardian" },
    { id: "ax", from: "a", to: "x", type: "adoptive_parent" },
    { id: "xb", from: "x", to: "b", type: "foster_parent" },
  ];
  assert.deepEqual(createKinshipAnalyzer([a, b, x, y], links)(a, b).path, [
    "a",
    "x",
    "b",
  ]);
  assert.equal(
    createKinshipAnalyzer([a, b, x, y], links.slice(0, 2))(a, b).kind,
    "unknown",
  );
  a.parents = ["x"];
  b.parents = ["y"];
  a.parentageComplete = b.parentageComplete = true;
  const steps: FamilyLink[] = [
    { id: "first", from: "y", to: "a", type: "step_parent" },
    { id: "second", from: "x", to: "b", type: "step_parent" },
  ];
  assert.deepEqual(createKinshipAnalyzer([a, b, x, y], steps)(a, b).path, [
    "a",
    "y",
    "b",
  ]);
  assert.deepEqual(
    createKinshipAnalyzer([a, b, x, y], steps.toReversed())(a, b).path,
    ["a", "x", "b"],
  );
});

test("prepared graph snapshots mutable inputs and never shares mutable result paths or roles", () => {
  const father = person("father", [], "m"),
    a = person("a", ["father"], "m"),
    b = person("b", ["father"], "f");
  const people = [father, a, b],
    endpoints = structuredClone([a, b]);
  const links: FamilyLink[] = [
    {
      id: "l",
      from: "a",
      to: "b",
      type: "twin",
      twinKind: "identical",
      note: "Исходная запись",
    },
  ];
  const prepared = createKinshipAnalyzer(people, links);
  const expected = prepared(endpoints[0], endpoints[1]);
  const damaged = prepared(endpoints[0], endpoints[1]);
  damaged.path.length = 0;
  damaged.roles![0].term = "changed";
  damaged.otherRelations![0].explanation = "changed";
  a.parents.length = 0;
  father.name = "Изменённый";
  links[0].type = "guardian";
  links[0].note = "Изменено";
  people.reverse();
  assert.deepEqual(prepared(endpoints[0], endpoints[1]), expected);
  assert.notDeepEqual(
    createKinshipAnalyzer(people, links)(endpoints[0], endpoints[1]),
    expected,
  );
  const absent = person("absent");
  assert.deepEqual(prepared(absent, absent).path, ["absent"]);
});

test("marriage wrapper keeps caller sex semantics, union snapshots and dynamic UTC status", (t) => {
  const a = { ...person("a"), name: "Иван", spouses: ["b"] },
    b = { ...person("b"), name: "Анна", spouses: ["a"] };
  const unions: FamilyUnion[] = [
    {
      id: "u",
      participants: ["a", "b"],
      type: "marriage",
      ongoing: { date: "2026-10-02" },
    },
  ];
  t.mock.method(
    Date.prototype,
    "toISOString",
    () => "2026-10-02T12:00:00.000Z",
  );
  const prepared = createKinshipAnalyzer([a, b], [], unions);
  assert.equal(prepared(a, b).roles![0].term, "супруг / супруга");
  unions[0].ongoing!.date = "1990-01-01";
  unions[0].divorce = {};
  assert.equal(prepared(a, b).title, "Супруги");
  t.mock.method(
    Date.prototype,
    "toISOString",
    () => "2026-10-03T12:00:00.000Z",
  );
  assert.equal(prepared(a, b).title, "Супруги и партнёры");
  assert.equal(
    analyzeKinship(a, b, [a, b], [], unions).title,
    "Бывшие супруги",
  );
});

test("explicit endpoint fields retain the legacy wrapper behavior even outside the graph snapshot", (t) => {
  t.mock.method(
    Date.prototype,
    "toISOString",
    () => "2026-10-02T12:00:00.000Z",
  );
  const a = { ...person("a", [], "m"), spouses: ["b"] },
    b = person("b", [], "f");
  const union: FamilyUnion = {
    id: "u",
    participants: ["a", "b"],
    type: "marriage",
    ongoing: { date: "2026-10-02" },
  };
  const analyze = createKinshipAnalyzer([a, b], [], [union]);
  const caller: Person = { ...a, sex: "u" };
  assert.deepEqual(
    analyze(caller, b),
    analyzeKinship(caller, b, [a, b], [], [union]),
  );
  assert.equal(analyze(caller, b).roles![0].term, "супруг / супруга");
  caller.sex = "f";
  assert.equal(analyze(caller, b).roles![0].term, "жена");
  caller.name = "Имя аргумента";
  const root = person("root"),
    x = person("x", ["root"]),
    y = person("y", ["root"]);
  const siblings = createKinshipAnalyzer([root, x, y]);
  const outside = { ...x, name: "Имя аргумента" };
  assert.deepEqual(
    siblings(outside, y),
    analyzeKinship(outside, y, [root, x, y]),
  );
  assert.match(siblings(outside, y).explanation, /Имя аргумента/u);
  const absent = { ...person("absent", [], "f"), spouses: ["b"] };
  assert.deepEqual(
    analyze(absent, b),
    analyzeKinship(absent, b, [a, b], [], [union]),
  );
});

test("one semantic label snapshot uses one UTC status even if first uncached labels straddle midnight", (t) => {
  const a = person("a", [], "f"),
    b = person("b", [], "m"),
    c = person("c", [], "m");
  a.spouses = ["b", "c"];
  const unions: FamilyUnion[] = [b, c].map((p) => ({
    id: p.id,
    participants: ["a", p.id],
    type: "marriage",
    ongoing: { date: "2026-10-02" },
  }));
  const key = kinshipLabelKey([a, b, c], [], unions, "2026-10-02");
  const label = createPersonRelationLabels(key, "a");
  t.mock.method(
    Date.prototype,
    "toISOString",
    () => "2026-10-02T23:59:59.000Z",
  );
  assert.equal(label(b), "Муж");
  t.mock.method(
    Date.prototype,
    "toISOString",
    () => "2026-10-03T00:00:01.000Z",
  );
  assert.equal(label(c), "Муж");
  assert.equal(label(b), "Муж");
  const nextDay = createPersonRelationLabels(
    kinshipLabelKey([a, b, c], [], unions, "2026-10-03"),
    "a",
  );
  assert.equal(nextDay(c), "Супруг / супруга (статус неизвестен)");
});

test("exiting, hidden or deleted cards cannot reuse relationships outside the current semantic snapshot", () => {
  const reference = person("reference", [], "f"),
    stale = person("removed", ["reference"], "m");
  const label = createPersonRelationLabels(
    kinshipLabelKey([reference], [], [], "2026-10-02"),
    "reference",
  );
  assert.equal(label(stale), "Родство не установлено");
  // The domain API retains its legacy external-endpoint behavior; the UI owns this guard.
  assert.throws(() => analyzeKinship(stale, reference, [reference]), TypeError);
  stale.spouses = ["reference"];
  assert.equal(analyzeKinship(stale, reference, [reference]).kind, "marriage");
  assert.equal(label(stale), "Родство не установлено");
  stale.spouses = [];
  const restored = createPersonRelationLabels(
    kinshipLabelKey([reference, stale], [], [], "2026-10-02"),
    "reference",
  );
  assert.equal(restored(stale), "Сын");
});

test("cache eviction and deep generation paths do not change subsequent pair results", () => {
  const people = Array.from({ length: 1000 }, (_, i) =>
    person(`p${i}`, i ? [`p${i - 1}`] : [], "m"),
  );
  const analyze = createKinshipAnalyzer(people);
  const expected = analyze(people[0], people[999]);
  assert.equal(expected.path.length, 1000);
  assert.deepEqual(expected.distances, [0, 999]);
  for (let i = 980; i < 1000; i++) analyze(people[i], people[999]);
  assert.deepEqual(analyze(people[0], people[999]), expected);
});

test("semantic label key survives detail hydration and covers every kinship input", () => {
  const { people, links, unions } = kinshipGraphs()[0];
  const day = "2026-10-02";
  const key = kinshipLabelKey(people, links, unions, day);
  const hydrated = structuredClone({ people, links, unions });
  for (const p of hydrated.people) {
    p.photo = "photo.jpg";
    p.biography = "Описание";
    p.birth = "1900";
    p.needsReview = true;
    p.sources.push({
      title: "Архив",
      type: "",
      reference: "",
      note: "",
      url: "",
    });
  }
  assert.equal(
    kinshipLabelKey(hydrated.people, hydrated.links, hydrated.unions, day),
    key,
  );
  const variants = [
    (data: typeof hydrated) => {
      data.people[0].name += "а";
    },
    (data: typeof hydrated) => {
      data.people[0].patronymic += "а";
    },
    (data: typeof hydrated) => {
      data.people[0].surname += "а";
    },
    (data: typeof hydrated) => {
      data.people[0].sex = data.people[0].sex === "m" ? "f" : "m";
    },
    (data: typeof hydrated) => {
      data.people[0].id += "x";
    },
    (data: typeof hydrated) => {
      data.people[0].parents.push("new");
    },
    (data: typeof hydrated) => {
      data.people[0].spouses.push("new");
    },
    (data: typeof hydrated) => {
      data.people[0].parentageComplete = !data.people[0].parentageComplete;
    },
    (data: typeof hydrated) => {
      data.people.reverse();
    },
    (data: typeof hydrated) => {
      data.links[0].note = "new";
    },
    (data: typeof hydrated) => {
      data.links[0].type = "twin";
    },
    (data: typeof hydrated) => {
      data.links[0].from += "x";
    },
    (data: typeof hydrated) => {
      data.links[0].to += "x";
    },
    (data: typeof hydrated) => {
      data.links[0].twinKind = "unknown";
    },
    (data: typeof hydrated) => {
      data.links.reverse();
    },
    (data: typeof hydrated) => {
      data.unions[0].participants.reverse();
    },
    (data: typeof hydrated) => {
      data.unions[0].formation = { date: "1900" };
    },
    (data: typeof hydrated) => {
      data.unions[0].ending = { date: "1950" };
    },
    (data: typeof hydrated) => {
      data.unions[0].divorce = {};
    },
    (data: typeof hydrated) => {
      data.unions[0].ongoing = { date: day };
    },
  ];
  for (const mutate of variants) {
    const data = structuredClone({ people, links, unions });
    mutate(data);
    assert.notEqual(
      kinshipLabelKey(data.people, data.links, data.unions, day),
      key,
      mutate.toString(),
    );
  }
  assert.notEqual(kinshipLabelKey(people, links, unions, "2026-10-03"), key);
  assert.notEqual(
    kinshipLabelKey(people, links, unions, day, "other-archive/account/grant"),
    key,
  );
  const label = createPersonRelationLabels(key, people[0].id);
  for (const p of people)
    assert.equal(
      label(p),
      personRelationLabel(p, people[0], people, links, unions),
    );
  const expected = label(people[1]);
  people[1].parents.length = 0;
  people[1].name = "Другое имя";
  assert.equal(label(people[1]), expected);
  assert.equal(
    createPersonRelationLabels(key, undefined)(people[1]),
    "",
  );
  assert.equal(
    createPersonRelationLabels(key, "not-recorded")(people[1]),
    "",
  );
  assert.equal(personRelationLabel(people[1], null, people, links, unions), "");
});
