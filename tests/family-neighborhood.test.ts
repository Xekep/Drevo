import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  familyNeighbors,
  familyNeighborhood,
  projectTree,
  completeVisibleParents,
  commonAncestorNetwork,
  bloodRelativesWithPartners,
} from "../src/domain/family-neighborhood.ts";
import { unionGeometry } from "../src/domain/union-layout.ts";
import { unionTimeline } from "../src/domain/union-timeline.ts";
import { visibleBranch } from "../src/domain/tree-layout.ts";
import type { Family, Person } from "../src/domain/types.ts";
const person = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
): Person => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  birth: "",
  sex: "u",
  birthPlace: "",
  parents,
  spouses,
  sources: [],
  column: 0,
  generation: 1,
});
function archive(): Family {
  return {
    demo: false,
    title: "Проверка",
    description: "",
    people: [
      person("great"),
      person("grandfather", ["great"], ["grandmother"]),
      person("grandmother", [], ["grandfather"]),
      person(
        "father",
        ["grandfather", "grandmother"],
        ["mother", "stepmother"],
      ),
      person("mother", [], ["father"]),
      person("stepmother", [], ["father"]),
      person("main", ["father", "mother"], ["spouse"]),
      person("spouse", [], ["main"]),
      person("sibling", ["father", "mother"], ["sibling-spouse"]),
      person("sibling-spouse", [], ["sibling"]),
      person("half-sibling", ["father", "stepmother"]),
      person("child", ["main", "spouse"]),
      person("niece", ["sibling", "sibling-spouse"]),
      person("outsider"),
      person("godparent"),
    ],
    links: [{ id: "god", type: "godparent", from: "godparent", to: "main" }],
  };
}
test("nearby family includes siblings, exact co-parents, partners and recorded godparents, but not every generation", () => {
  const data = archive(),
    before = structuredClone(data);
  const view = familyNeighborhood(familyNeighbors(data), "main");
  assert.deepEqual(
    [...view.visible].sort(),
    [
      "main",
      "spouse",
      "father",
      "mother",
      "stepmother",
      "sibling",
      "sibling-spouse",
      "half-sibling",
      "child",
      "godparent",
    ].sort(),
  );
  assert.equal(view.hidden.get("father"), 2);
  assert.equal(view.hidden.get("sibling"), 1);
  assert.deepEqual(data, before);
});

test("common ancestors include the full blood branch but exclude spouses, stepfamily and godparents", () => {
  const data = archive();
  const index = familyNeighbors(data);
  const visible = commonAncestorNetwork(index, "main");
  assert.deepEqual(
    [...visible].sort(),
    [
      "main",
      "father",
      "mother",
      "grandfather",
      "grandmother",
      "great",
      "sibling",
      "half-sibling",
      "child",
      "niece",
    ].sort(),
  );
  for (const id of [
    "spouse",
    "stepmother",
    "sibling-spouse",
    "godparent",
    "outsider",
  ])
    assert.equal(visible.has(id), false, id);
  assert.deepEqual([...commonAncestorNetwork(index, "outsider")], ["outsider"]);
  assert.equal(commonAncestorNetwork(index, "missing").size, 0);
});
test("blood view adds recorded partners once without extending the blood or access network", () => {
  const data = archive();
  data.people.find((p) => p.id === "sibling")!.spouses = [];
  data.people.find((p) => p.id === "stepmother")!.spouses.push("outsider");
  data.people.find((p) => p.id === "outsider")!.spouses = ["stepmother"];
  const index = familyNeighbors(data);
  const visible = bloodRelativesWithPartners(index, "main");
  for (const id of ["spouse", "stepmother", "sibling-spouse"])
    assert.ok(visible.has(id), id);
  for (const id of ["outsider", "godparent"])
    assert.equal(visible.has(id), false, id);
  assert.equal(commonAncestorNetwork(index, "main").has("spouse"), false);
  assert.equal(bloodRelativesWithPartners(index, "missing").size, 0);
});
test("branches expand one step at a time and folding the access point removes detached expansions", () => {
  const index = familyNeighbors(archive());
  const first = familyNeighborhood(index, "main", new Set(["father"]));
  assert.ok(
    first.visible.has("grandfather") && first.visible.has("grandmother"),
  );
  assert.ok(!first.visible.has("great"));
  const second = familyNeighborhood(
    index,
    "main",
    new Set(["father", "grandfather"]),
  );
  assert.ok(second.visible.has("great"));
  const folded = familyNeighborhood(index, "main", new Set(["grandfather"]));
  assert.ok(!folded.visible.has("grandfather") && !folded.visible.has("great"));
});
test("comparison preserves the connecting path and a disconnected selected person without inventing a relation", () => {
  const data = archive();
  const view = familyNeighborhood(familyNeighbors(data), "main", new Set(), [
    "great",
    "outsider",
    "missing",
  ]);
  for (const id of ["main", "father", "grandfather", "great", "outsider"])
    assert.ok(view.visible.has(id));
  assert.ok(!view.visible.has("missing"));
  const projected = projectTree(data, view.visible);
  assert.deepEqual(
    projected.people.find((p) => p.id === "outsider")!.parents,
    [],
  );
  assert.equal(projected.links.length, 1);
});
test("half-siblings keep different parental families even without a recorded marriage", async () => {
  const data = archive();
  for (const p of data.people) p.spouses = [];
  const view = familyNeighborhood(familyNeighbors(data), "main");
  assert.ok(
    view.visible.has("stepmother"),
    "the known co-parent must not be hidden",
  );
  const projected = projectTree(data, view.visible);
  const g = await unionGeometry(
    projected.people,
    (graph) => new ELK().layout(graph),
    false,
    projected.links,
  );
  const main = g.branches!.find(
    (b) =>
      b.id.startsWith("child:") &&
      b.relations.some((r) => r.to === "main" && r.type === "parent"),
  )!;
  const half = g.branches!.find(
    (b) =>
      b.id.startsWith("child:") &&
      b.relations.some((r) => r.to === "half-sibling" && r.type === "parent"),
  )!;
  assert.notEqual(main.union, half.union);
  assert.deepEqual(main.relations.map((r) => r.from).sort(), [
    "father",
    "mother",
  ]);
  assert.deepEqual(half.relations.map((r) => r.from).sort(), [
    "father",
    "stepmother",
  ]);
});
test("all recorded types of additional relationship can be revealed without becoming biological parents", () => {
  const data = archive();
  for (const type of [
    "adoptive_parent",
    "guardian",
    "nurse",
    "sworn_sibling",
  ] as const) {
    data.links!.push({ id: type, type, from: "father", to: "outsider" });
  }
  const index = familyNeighbors(data);
  assert.ok(!familyNeighborhood(index, "main").visible.has("outsider"));
  const shown = familyNeighborhood(index, "main", new Set(["father"]));
  const projected = projectTree(data, shown.visible);
  assert.ok(shown.visible.has("outsider"));
  assert.deepEqual(
    projected.people.find((p) => p.id === "outsider")!.parents,
    [],
  );
  assert.deepEqual(
    projected.links.map((l) => l.type).sort(),
    data.links!.map((l) => l.type).sort(),
  );
});
test("focused layout recalculates the visible family and preserves dates in chronology", async () => {
  const data = archive();
  for (const p of data.people) p.birth = p.id === "main" ? "1985-04-07" : "";
  const view = familyNeighborhood(familyNeighbors(data), "main");
  const projected = projectTree(data, view.visible);
  for (const reverse of [false, true]) {
    const g = await unionGeometry(
      projected.people,
      (graph) => new ELK().layout(graph),
      reverse,
      projected.links,
    );
    assert.deepEqual(
      new Set(g.occurrences!.map((o) => o.personId)),
      view.visible,
    );
    const saved = new Set(
      data.people.flatMap((p) =>
        p.parents.map((from) => JSON.stringify([from, p.id])),
      ),
    );
    for (const branch of g.branches!)
      for (const r of branch.relations)
        if (r.type === "parent")
          assert.ok(saved.has(JSON.stringify([r.from, r.to])));
    const base = reverse
      ? await unionGeometry(
          projected.people,
          (graph) => new ELK().layout(graph),
          false,
          projected.links,
        )
      : g;
    const timeline = unionTimeline(
      projected.people,
      base,
      reverse,
      projected.links,
    );
    assert.equal(timeline.positions.length, g.positions.length);
    assert.equal(
      projected.people.find((p) => p.id === "main")!.birth,
      "1985-04-07",
    );
  }
});
test("names and biography do not change the worker request", () => {
  const data = archive(),
    visible = familyNeighborhood(familyNeighbors(data), "main").visible;
  const before = JSON.stringify(projectTree(data, visible));
  data.people[0].surname = "Другая фамилия";
  data.people.find((p) => p.id === "main")!.name = "Новое имя";
  data.people.find((p) => p.id === "main")!.biography = "Новые сведения";
  assert.equal(JSON.stringify(projectTree(data, new Set(visible))), before);
  assert.equal(
    projectTree(data, new Set(data.people.map((p) => p.id))).people.length,
    data.people.length,
  );
});
test("empty archives and missing endpoints remain safe", () => {
  assert.equal(
    familyNeighborhood(familyNeighbors({ people: [] }), "missing").visible.size,
    0,
  );
  const data = { people: [person("a", ["absent"], ["absent"])], links: [] };
  const view = familyNeighborhood(familyNeighbors(data), "a");
  assert.deepEqual([...view.visible], ["a"]);
  assert.equal(view.hidden.size, 0);
});

test("protected children in the full view retain both parental pairs when another branch is collapsed", () => {
  const index = familyNeighbors(archive());
  const visible = completeVisibleParents(
    index,
    new Set(["father", "main", "half-sibling"]),
  );
  assert.deepEqual(
    [...visible].sort(),
    ["father", "main", "half-sibling", "mother", "stepmother"].sort(),
  );
  assert.ok(!visible.has("grandfather") && !visible.has("sibling"));
});

test("collapsing descendants hides their detached partners and in-laws, preserving the boundary couple and unrelated families", () => {
  const data = archive();
  data.people.find((p) => p.id === "spouse")!.parents = ["in-law"];
  data.people.find((p) => p.id === "spouse")!.spouses.push("later-partner");
  data.people.push(
    person("in-law"),
    person("later-partner", [], ["spouse"]),
    person("other-partner", [], ["outsider"]),
  );
  const before = structuredClone(data);
  assert.deepEqual(
    [...visibleBranch(data, null, new Set(["father"]))].sort(),
    [
      "great",
      "grandfather",
      "grandmother",
      "father",
      "mother",
      "stepmother",
      "outsider",
      "other-partner",
    ].sort(),
  );
  assert.deepEqual(
    visibleBranch(data, null, new Set()),
    new Set(data.people.map((p) => p.id)),
  );
  assert.deepEqual(data, before);
});

test("a hidden descendant's partners stay when another recorded path connects them to the visible tree", () => {
  const data = archive();
  data.people.find((p) => p.id === "spouse")!.parents = ["grandfather"];
  data.links!.push({
    id: "independent",
    type: "guardian",
    from: "great",
    to: "sibling-spouse",
  });
  const visible = visibleBranch(data, null, new Set(["father"]));
  assert.ok(
    visible.has("spouse"),
    "a partner's own visible parent preserves their branch",
  );
  assert.ok(
    visible.has("sibling-spouse"),
    "an independent recorded relationship preserves their branch",
  );
  for (const id of ["main", "sibling", "child", "niece", "godparent"])
    assert.equal(visible.has(id), false, id);
});

test("co-parents of hidden children disappear even without a recorded marriage", () => {
  const data = archive();
  for (const p of data.people) p.spouses = [];
  const visible = visibleBranch(data, null, new Set(["main"]));
  assert.equal(visible.has("child"), false);
  assert.equal(visible.has("spouse"), false);
  for (const id of [
    "main",
    "father",
    "mother",
    "sibling",
    "sibling-spouse",
    "niece",
  ])
    assert.ok(visible.has(id), id);
});

test("explicitly protected people keep their attached families and exact parental pairs after a fold", () => {
  const data = archive();
  data.people.find((p) => p.id === "spouse")!.parents = ["in-law"];
  data.people.push(person("in-law"));
  const protectedSpouse = visibleBranch(data, null, new Set(["father"]), [
    "spouse",
    "missing",
  ]);
  for (const id of ["spouse", "in-law", "father"])
    assert.ok(protectedSpouse.has(id), id);
  assert.equal(protectedSpouse.has("sibling-spouse"), false);
  assert.equal(protectedSpouse.has("missing"), false);
  const protectedChild = completeVisibleParents(
    familyNeighbors(data),
    visibleBranch(data, null, new Set(["father"]), ["child"]),
  );
  for (const id of ["father", "child", "main", "spouse", "in-law"])
    assert.ok(protectedChild.has(id), id);
  assert.equal(protectedChild.has("sibling"), false);
});

test("rooted and blood views remove detached spouses while retaining the collapsed person's own partners", () => {
  const data = archive();
  assert.deepEqual(
    [...visibleBranch(data, "father", new Set(["father"]))].sort(),
    [
      "great",
      "grandfather",
      "grandmother",
      "father",
      "mother",
      "stepmother",
    ].sort(),
  );
  const blood = bloodRelativesWithPartners(familyNeighbors(data), "father");
  const branch = visibleBranch(data, null, new Set(["father"]), ["father"]);
  const visible = new Set([...blood].filter((id) => branch.has(id)));
  assert.equal(visible.has("spouse"), false);
  assert.equal(visible.has("sibling-spouse"), false);
  assert.ok(visible.has("mother") && visible.has("stepmother"));
});

test("an outer fold hides nested folded couples and reopening restores their previous fold", () => {
  const data = archive();
  const collapsed = new Set(["main", "father"]);
  const outer = visibleBranch(data, null, collapsed);
  for (const id of ["main", "spouse", "child", "sibling-spouse"])
    assert.equal(outer.has(id), false, id);
  assert.ok(outer.has("father") && outer.has("mother"));
  const inner = visibleBranch(data, null, new Set(["main"]));
  assert.ok(inner.has("main") && inner.has("spouse"));
  assert.equal(inner.has("child"), false);
  const protectedInner = visibleBranch(data, null, collapsed, ["main"]);
  assert.ok(protectedInner.has("main") && protectedInner.has("spouse"));
  assert.equal(protectedInner.has("child"), false);
  assert.deepEqual(collapsed, new Set(["main", "father"]));
});

test("a thousand-person branch folds and restores without recursion, including malformed ancestry cycles", () => {
  const people = [person("root"), person("unrelated")];
  for (let i = 1; i <= 499; i++) {
    const id = `child-${i}`;
    people.push(
      person(id, [i === 1 ? "root" : `child-${i - 1}`], [`partner-${i}`]),
      person(`partner-${i}`),
    );
  }
  const data = { ...archive(), people, links: [] };
  for (const parents of [[], ["child-499"]]) {
    people[0].parents = parents;
    assert.deepEqual([...visibleBranch(data, null, new Set(["root"]))].sort(), [
      "root",
      "unrelated",
    ]);
    assert.equal(visibleBranch(data, null, new Set()).size, 1000);
  }
});
