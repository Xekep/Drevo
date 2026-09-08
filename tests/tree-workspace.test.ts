import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveConnections,
  connectionKey,
  connectPeople,
  replaceConnection,
  canChangeConnection,
  archiveChanges,
  applyArchiveChanges,
  inverseChanges,
  validateFamily,
  treeGeometry,
  generationLevels,
  visibleBranch,
  matchesPerson,
  TREE_NODE_HEIGHT,
  type Person,
  type Family,
  type ConnectionType,
} from "../src/domain/index.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { startServer } from "../src/server/index.ts";
const person = (id: string, parents: string[] = [], birth = ""): Person => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  birth,
  sex: "u",
  birthPlace: "",
  parents,
  spouses: [],
  sources: [],
  column: 0,
  generation: 1,
  createdBy: "relative",
});
const family = (...people: Person[]): Family => ({
  title: "Архив",
  description: "",
  demo: false,
  people,
});
test("search combines name, birth surname and places without inventing an unknown birth year", () => {
  const p = { ...person("Алёна"), maidenName: "Ершова", deathPlace: "Тверь" };
  assert.equal(matchesPerson(p, "  алена тверь "), true);
  assert.equal(matchesPerson(p, "ершова"), true);
  assert.equal(matchesPerson(p, String(new Date().getFullYear())), false);
});

test("adapter retains every relationship kind and gives symmetric marriage one stable key", () => {
  let data = family(person("a"), person("b"), person("c"));
  for (const type of [
    "parent",
    "spouse",
    "adoptive_parent",
    "godparent",
    "guardian",
    "nurse",
    "sworn_sibling",
  ] as ConnectionType[])
    data = connectPeople(data, "a", "b", type);
  const edges = archiveConnections(data);
  assert.equal(edges.length, 7);
  assert.equal(new Set(edges.map((e) => e.key)).size, 7);
  assert.equal(
    connectionKey({ from: "a", to: "b", type: "spouse" }),
    connectionKey({ from: "b", to: "a", type: "spouse" }),
  );
  assert.notEqual(
    connectionKey({ from: "a", to: "b", type: "parent" }),
    connectionKey({ from: "b", to: "a", type: "parent" }),
  );
});
test("reconnecting a parent is one validated operation and undo restores flags without changing another person", () => {
  const data = family(person("a"), person("b", ["a"]), person("c"));
  data.people[1].parentageComplete = true;
  const edge = archiveConnections(data)[0];
  assert.deepEqual(replaceConnection(data, edge, edge), data);
  const changed = replaceConnection(data, edge, {
    from: "c",
    to: "b",
    type: "parent",
  });
  assert.deepEqual(changed.people[1].parents, ["c"]);
  assert.deepEqual(data.people[1].parents, ["a"]);
  const current = structuredClone(changed);
  current.people[0].biography = "Правка другого участника";
  const undone = applyArchiveChanges(
    current,
    inverseChanges(archiveChanges(data, changed)),
  );
  assert.equal(undone.conflicts.length, 0);
  assert.deepEqual(undone.family.people[1], data.people[1]);
  assert.equal(undone.family.people[0].biography, "Правка другого участника");
  validateFamily(undone.family);
});
test("reconnect rejects cycles, duplicate relations and contradictory dates before saving", () => {
  let data = family(
    person("a", [], "1930"),
    person("b", ["a"], "1960"),
    person("c", ["b"], "1990"),
    person("d", [], "2000"),
  );
  const edge = archiveConnections(data)[0];
  assert.throws(() =>
    replaceConnection(data, edge, { from: "c", to: "b", type: "parent" }),
  );
  assert.throws(() =>
    replaceConnection(data, edge, { from: "d", to: "b", type: "parent" }),
  );
  data = connectPeople(data, "a", "c", "guardian");
  data = connectPeople(data, "b", "c", "guardian");
  const guardian = archiveConnections(data).find(
    (e) => e.type === "guardian" && e.from === "a",
  )!;
  assert.throws(
    () =>
      replaceConnection(data, guardian, {
        from: "b",
        to: "c",
        type: "guardian",
      }),
    /существует/,
  );
});
test("additional edge preserves identity, ownership and edited note across endpoint and type changes", () => {
  const data = connectPeople(
    family(person("a"), person("b"), person("c")),
    "a",
    "b",
    "godparent",
    "Источник 1",
  );
  data.links![0].createdBy = "relative";
  const edge = archiveConnections(data)[0];
  const changed = replaceConnection(data, edge, {
    from: "c",
    to: "b",
    type: "guardian",
    note: "Источник 2",
  });
  assert.equal(changed.links![0].id, edge.id);
  assert.equal(changed.links![0].createdBy, "relative");
  assert.equal(changed.links![0].note, "Источник 2");
  const user = {
    id: "relative",
    name: "Участник",
    role: "relative" as const,
    createdAt: "",
  };
  assert.equal(canChangeConnection(data, user, edge), true);
  assert.doesNotThrow(() => authorizeArchive(changed, data, user));
  data.people[2].createdBy = "someone-else";
  assert.equal(
    canChangeConnection(data, user, { from: "c", to: "b", type: "guardian" }),
    false,
  );
  assert.throws(() => authorizeArchive(changed, data, user));
  assert.equal(
    canChangeConnection(data, { ...user, role: "reader" }, edge),
    false,
  );
});
test("three-way merge keeps independent fields, exposes overlapping edits and preserves the draft", () => {
  const base = family(person("a")),
    draft = structuredClone(base),
    current = structuredClone(base);
  draft.people[0].biography = "Мой текст";
  draft.people[0].birth = "1950";
  current.people[0].biography = "Текст из другой вкладки";
  current.people[0].surname = "Новая фамилия";
  const changes = archiveChanges(base, draft);
  const result = applyArchiveChanges(current, changes);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].change.field, "biography");
  assert.equal(result.family.people[0].biography, "Текст из другой вкладки");
  assert.equal(result.family.people[0].birth, "1950");
  const local = applyArchiveChanges(current, changes, "local").family;
  assert.equal(local.people[0].biography, "Мой текст");
  assert.equal(local.people[0].surname, "Новая фамилия");
  assert.equal(draft.people[0].surname, "Тестов");
  assert.equal(current.people[0].birth, "");
});
test("undo will not silently remove a newly referenced person or overwrite a later edit", () => {
  const base = family(person("a")),
    created = family(...base.people, person("b"));
  const remote = connectPeople(created, "b", "a", "parent");
  const undo = applyArchiveChanges(
    remote,
    inverseChanges(archiveChanges(base, created)),
  );
  assert.throws(() => validateFamily(undo.family));
  const edited = structuredClone(base);
  edited.people[0].name = "Моя правка";
  const later = structuredClone(edited);
  later.people[0].name = "Новая правка";
  assert.equal(
    applyArchiveChanges(later, inverseChanges(archiveChanges(base, edited)))
      .conflicts.length,
    1,
  );
});
test("generations use actual parents, align an undated spouse, and include adoption without mutating evidence", () => {
  const data = family(
    person("a"),
    person("b", ["a"]),
    person("spouse"),
    person("child", ["b", "spouse"]),
    person("adopted"),
  );
  data.people[1].spouses = ["spouse"];
  data.people[2].spouses = ["b"];
  data.links = [
    { id: "adopt", from: "b", to: "adopted", type: "adoptive_parent" },
  ];
  const before = structuredClone(data);
  for (const reverse of [false, true]) {
    const layout = treeGeometry(
        data.people,
        "generations",
        reverse,
        data.links,
      ),
      positions = new Map(layout.positions);
    assert.equal(positions.get("b")!.y, positions.get("spouse")!.y);
    assert.equal(positions.get("child")!.y, positions.get("adopted")!.y);
    assert.equal(positions.get("a")!.y < positions.get("b")!.y, !reverse);
    assert.equal(
      new Set(layout.positions.map(([, p]) => `${p.x}:${p.y}`)).size,
      data.people.length,
    );
  }
  assert.deepEqual(data, before);
});
test("timeline keeps exact years and separates 100 undated people into bounded rows in both directions", () => {
  const people = Array.from({ length: 100 }, (_, i) => person(`u-${i}`));
  people.push(
    person("dated-a", [], "1900"),
    person("dated-b", [], "1910"),
    person("same-year", [], "1900"),
  );
  for (const reverse of [false, true]) {
    const layout = treeGeometry(people, "timeline", reverse),
      points = new Map(layout.positions);
    assert.ok(layout.offset > 0);
    assert.equal(
      Math.abs(points.get("dated-a")!.y - points.get("dated-b")!.y),
      80,
    );
    assert.notEqual(points.get("dated-a")!.x, points.get("same-year")!.x);
    assert.ok(
      people
        .filter((p) => !p.birth)
        .every(
          (p) =>
            points.get(p.id)!.x <= 5 * 316 &&
            points.get(p.id)!.y + TREE_NODE_HEIGHT < layout.offset,
        ),
    );
    assert.equal(
      new Set(layout.positions.map(([, p]) => `${p.x}:${p.y}`)).size,
      people.length,
    );
  }
});
test("layout handles 10000 people and a deep lineage without recursive stack growth", () => {
  const people = Array.from({ length: 10000 }, (_, i) =>
    person(`p-${i}`, i ? [`p-${i - 1}`] : []),
  );
  const before = performance.now(),
    levels = generationLevels(people);
  const layout = treeGeometry(people, "generations");
  assert.equal(levels.get("p-9999"), 9999);
  assert.equal(layout.positions.length, 10000);
  assert.ok(
    layout.positions.every(
      ([, p]) => Number.isFinite(p.x) && Number.isFinite(p.y),
    ),
  );
  console.log(
    `10000 человек: раскладка и уровни ${Math.round(performance.now() - before)} мс; ${Buffer.byteLength(JSON.stringify(layout))} байт координат`,
  );
});

test("family layout centers children below co-parents and gives branches room without inventing marriages", () => {
  const data = family(
    person("father"),
    person("mother"),
    person("child", ["father", "mother"]),
    person("sibling", ["father", "mother"]),
    person("grandchild", ["child"]),
  );
  const before = structuredClone(data);
  for (const mode of ["generations", "timeline"] as const) {
    const points = new Map(treeGeometry(data.people, mode).positions);
    const parentCenter =
      (points.get("father")!.x + points.get("mother")!.x) / 2;
    const childrenCenter =
      (points.get("child")!.x + points.get("sibling")!.x) / 2;
    assert.equal(parentCenter, childrenCenter);
    assert.equal(points.get("child")!.x, points.get("grandchild")!.x);
    assert.equal(points.get("father")!.y, points.get("mother")!.y);
    for (const [id, a] of points)
      for (const [other, b] of points) {
        if (id === other) continue;
        assert.ok(
          Math.abs(a.x - b.x) >= 220 || Math.abs(a.y - b.y) >= TREE_NODE_HEIGHT,
          `${id} overlaps ${other}`,
        );
      }
  }
  assert.deepEqual(data, before);
});
test("branch focus and collapsing preserve selected cards while excluding unrelated branches", () => {
  const data = family(
    person("a"),
    person("b", ["a"]),
    person("c", ["b"]),
    person("other"),
  );
  assert.deepEqual([...visibleBranch(data, "b", new Set())].sort(), [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual([...visibleBranch(data, "b", new Set(["b"]))].sort(), [
    "a",
    "b",
  ]);
  assert.deepEqual(
    [...visibleBranch(data, "b", new Set(["b"]), ["c"])].sort(),
    ["a", "b", "c"],
  );
});
test("HTTP revision conflict can be merged and endpoint replacement is committed with one revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-tree-")),
    app = await startServer(0, join(dir, "tree.sqlite"), true);
  try {
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const initial = family(person("a"), person("b", ["a"]), person("c"));
    app.archive.write(initial, app.archive.read().revision);
    const first = await (await fetch(origin + "/api/family")).json();
    const draft = replaceConnection(
      first.family,
      archiveConnections(first.family)[0],
      { from: "c", to: "b", type: "parent" },
    );
    const concurrent = structuredClone(first.family);
    concurrent.people[0].biography = "Чужая правка";
    app.archive.write(concurrent, first.revision);
    const put = (body: Family, revision: number) =>
      fetch(origin + "/api/family", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(revision),
        },
        body: JSON.stringify(body),
      });
    assert.equal((await put(draft, first.revision)).status, 409);
    const fresh = await (await fetch(origin + "/api/family")).json();
    const merged = applyArchiveChanges(
      fresh.family,
      archiveChanges(first.family, draft),
    );
    assert.equal(merged.conflicts.length, 0);
    const response = await put(merged.family, fresh.revision);
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.revision, fresh.revision + 1);
    assert.deepEqual(saved.family.people[1].parents, ["c"]);
    assert.equal(saved.family.people[0].biography, "Чужая правка");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
