import assert from "node:assert/strict";
import test from "node:test";
import type { ArchiveUser } from "../src/domain/access.ts";
import {
  archiveConnections,
  connectionKey,
} from "../src/domain/connections.ts";
import type { Family, Person } from "../src/domain/types.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import type { RelationshipEdgeType } from "../src/components/tree/relationship-edge.tsx";
import {
  applyTreeEdgePermissions,
  buildTreeEdges,
  prepareTreeEdges,
} from "../src/components/tree/tree-edge-adapter.ts";

const owner: ArchiveUser = {
  id: "owner",
  name: "Исследователь",
  role: "researcher",
  createdAt: "",
};
const admin: ArchiveUser = { ...owner, id: "admin", role: "admin" };
function person(id: string, createdBy = owner.id): Person {
  return {
    id,
    createdBy,
    name: id,
    surname: "Тестов",
    patronymic: "",
    sex: "u",
    birth: "",
    birthPlace: "",
    parents: [],
    spouses: [],
    generation: 0,
    column: 0,
    sources: [],
  };
}
function fixture(branches = false) {
  const family: Family = {
    title: "Тест",
    description: "",
    demo: false,
    people: [person("a"), { ...person("b"), parents: ["a", "c"] }, person("c")],
    links: [
      {
        id: "extra",
        from: "a",
        to: "b",
        type: "godparent",
        createdBy: owner.id,
        sources: [{ title: "Запись", type: "document", reference: "1" }],
      },
    ],
  };
  const connections = archiveConnections(family);
  const parentRelations = [
    { from: "a", to: "b", type: "parent" as const },
    { from: "c", to: "b", type: "parent" as const },
  ];
  const positions = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 0, y: 400 }],
    ["c", { x: 400, y: 0 }],
  ]);
  const route = {
    sourceHandle: "bottom" as const,
    targetHandle: "top" as const,
    points: [
      { x: 110, y: 264 },
      { x: 110, y: 400 },
    ],
  };
  const geometry: TreeGeometry = {
    mode: "generations",
    reverse: false,
    positions: [...positions],
    start: 1800,
    offset: 0,
    routes: [[JSON.stringify(["godparent", "a", "b"]), route]],
    ...(branches
      ? {
          branches: [
            {
              id: "child:parents",
              source: "a",
              target: "b",
              union: "union:parents",
              relations: parentRelations,
              route,
            },
          ],
          coveredRelations: parentRelations.map(({ from, to, type }) =>
            JSON.stringify([type, from, to]),
          ),
        }
      : {}),
  };
  const input = {
    family,
    user: owner,
    canEdit: false,
    busy: false,
    mode: "generations" as const,
    geometry,
    connections,
    visible: new Set(family.people.map(({ id }) => id)),
    positions,
    occurrencePeople: new Map(family.people.map(({ id }) => [id, id])),
    peopleMap: new Map(family.people.map((item) => [item.id, item])),
    highlighted: [],
    selectedEdge: undefined,
    extraVisible: true,
    preview: null as { from: string; to: string } | null,
    onEdge: (edge: (typeof connections)[number]) => {
      void edge;
    },
    onChoices: (edges: typeof connections) => {
      void edges;
    },
    growthDelays: new Map<string, number>(),
  };
  return input;
}
function press(edge: RelationshipEdgeType, key: string) {
  const handler = edge.domAttributes?.onKeyDown;
  assert.ok(handler);
  let prevented = false;
  handler({
    key,
    preventDefault: () => {
      prevented = true;
    },
  } as Parameters<typeof handler>[0]);
  assert.equal(prevented, key === "Enter" || key === " ");
}
function visualEdges(edges: RelationshipEdgeType[]) {
  return edges.map((edge) => ({
    ...edge,
    domAttributes: undefined,
    data: edge.data && { ...edge.data, onSelect: undefined },
  }));
}

test("branch-only permission changes retain the entire prepared array, including drafts", () => {
  const input = fixture(true);
  const prepared = prepareTreeEdges({
    ...input,
    extraVisible: false,
    preview: { from: "b", to: "c" },
  });
  assert.deepEqual(prepared.directIndices, []);
  assert.deepEqual(
    prepared.edges.map(({ id }) => id),
    ["child:parents", "draft-preview"],
  );
  for (const user of [null, owner, admin])
    for (const canEdit of [false, true])
      for (const busy of [false, true]) {
        assert.strictEqual(
          applyTreeEdgePermissions(prepared, { ...input, user, canEdit, busy }),
          prepared.edges,
        );
        assert.ok(prepared.edges.every((edge) => edge.reconnectable === false));
      }
});

test("mixed branches only update direct permissions and preserve routes, labels, sources and handlers", () => {
  const input = fixture(true);
  const prepared = prepareTreeEdges({
    ...input,
    preview: { from: "b", to: "c" },
  });
  assert.deepEqual(prepared.directIndices, [1]);
  const original = prepared.edges[1];
  const editable = applyTreeEdgePermissions(prepared, {
    ...input,
    canEdit: true,
  });
  assert.notStrictEqual(editable, prepared.edges);
  assert.strictEqual(editable[0], prepared.edges[0]);
  assert.strictEqual(editable[2], prepared.edges[2]);
  assert.equal(editable[1].reconnectable, true);
  assert.equal(original.reconnectable, false);
  assert.strictEqual(editable[1].data, original.data);
  assert.strictEqual(editable[1].style, original.style);
  assert.strictEqual(editable[1].markerEnd, original.markerEnd);
  assert.strictEqual(editable[1].domAttributes, original.domAttributes);
  assert.ok(editable[1].data?.route);
  assert.equal(editable[1].data?.label, original.data?.label);
  assert.deepEqual(
    editable[1].data?.connection.sources,
    input.family.links![0].sources,
  );
  assert.deepEqual(
    visualEdges(editable),
    visualEdges(
      buildTreeEdges({
        ...input,
        canEdit: true,
        preview: { from: "b", to: "c" },
      }),
    ),
  );
  for (const changed of [{ canEdit: false }, { busy: true }, { user: null }]) {
    const revoked = applyTreeEdgePermissions(prepared, {
      ...input,
      canEdit: true,
      ...changed,
    });
    assert.strictEqual(revoked, prepared.edges);
    assert.equal(revoked[1].reconnectable, false);
  }
});

test("live ownership distinguishes target-only parents, both spouses and additional-link authors", () => {
  const input = fixture();
  const spouse = {
    from: "a",
    to: "b",
    type: "spouse" as const,
    key: connectionKey({ from: "a", to: "b", type: "spouse" }),
  };
  const parent = input.connections.find(
    (edge) => edge.type === "parent" && edge.from === "a",
  )!;
  const extra = input.connections.find((edge) => edge.id === "extra")!;
  const prepared = prepareTreeEdges({
    ...input,
    connections: [parent, spouse, extra],
  });
  const flags = (values: Parameters<typeof applyTreeEdgePermissions>[1]) =>
    applyTreeEdgePermissions(prepared, values).map(
      (edge) => edge.reconnectable,
    );
  assert.deepEqual(flags({ ...input, canEdit: true }), [true, true, true]);
  const foreignSource = new Map(input.peopleMap);
  foreignSource.set("a", person("a", "other"));
  assert.deepEqual(
    flags({ ...input, canEdit: true, peopleMap: foreignSource }),
    [true, false, false],
  );
  const foreignTarget = new Map(input.peopleMap);
  foreignTarget.set("b", person("b", "other"));
  assert.deepEqual(
    flags({ ...input, canEdit: true, peopleMap: foreignTarget }),
    [false, false, false],
  );
  const otherLinkAuthor = {
    ...input.family,
    links: input.family.links!.map((link) => ({ ...link, createdBy: "other" })),
  };
  assert.deepEqual(
    flags({ ...input, family: otherLinkAuthor, canEdit: true }),
    [true, true, false],
  );
  assert.deepEqual(
    flags({ ...input, user: { ...owner, role: "reader" }, canEdit: true }),
    [false, false, false],
  );
  assert.deepEqual(
    flags({
      ...input,
      user: admin,
      family: otherLinkAuthor,
      peopleMap: foreignTarget,
      canEdit: true,
    }),
    [true, true, true],
  );
  assert.deepEqual(flags({ ...input, user: admin, canEdit: false }), [
    false,
    false,
    false,
  ]);
  assert.deepEqual(
    flags({ ...input, user: admin, canEdit: true, busy: true }),
    [false, false, false],
  );
});

test("preparing new action callbacks keeps mouse and keyboard selection current for direct and ambiguous branches", () => {
  const input = fixture(true);
  let oldCalls = 0;
  prepareTreeEdges({
    ...input,
    onEdge: () => {
      oldCalls++;
    },
    onChoices: () => {
      oldCalls++;
    },
  });
  const selected: string[] = [];
  const choices: string[][] = [];
  const prepared = prepareTreeEdges({
    ...input,
    onEdge: (edge) => selected.push(edge.key),
    onChoices: (edges) => choices.push(edges.map(({ key }) => key)),
  });
  const bound = applyTreeEdgePermissions(prepared, { ...input, canEdit: true });
  const branch = bound[0],
    direct = bound[1];
  direct.data!.onSelect(direct.data!.connection);
  press(direct, "Enter");
  press(direct, "ArrowRight");
  branch.data!.onSelect(branch.data!.connection);
  press(branch, " ");
  assert.equal(oldCalls, 0);
  assert.deepEqual(selected, [direct.id, direct.id]);
  assert.deepEqual(choices, [
    input.connections
      .filter((edge) => edge.type === "parent")
      .map(({ key }) => key),
    input.connections
      .filter((edge) => edge.type === "parent")
      .map(({ key }) => key),
  ]);
});

test("actual name, sex and link evidence changes refresh preparation without changing the geometry", () => {
  const input = fixture(true);
  const previous = prepareTreeEdges(input);
  const source = { title: "Новая запись", type: "document", reference: "2" };
  const updated: Family = {
    ...input.family,
    people: input.family.people.map((person) =>
      person.id === "a"
        ? { ...person, name: "Анна", sex: "f" }
        : person.id === "b"
          ? { ...person, name: "Борис", sex: "m" }
          : person,
    ),
    links: input.family.links!.map((link) => ({
      ...link,
      note: "Уточнено",
      sources: [source],
    })),
  };
  const updatedInput = {
    ...input,
    family: updated,
    connections: archiveConnections(updated),
    peopleMap: new Map(updated.people.map((person) => [person.id, person])),
  };
  const prepared = prepareTreeEdges(updatedInput);
  const bound = applyTreeEdgePermissions(prepared, {
    ...updatedInput,
    canEdit: true,
  });
  assert.equal(bound[1].data?.label, "Крёстная мать → крестник");
  assert.notEqual(bound[1].data?.label, previous.edges[1].data?.label);
  assert.equal(bound[1].data?.connection.note, "Уточнено");
  assert.strictEqual(bound[1].data?.connection.sources?.[0], source);
  assert.match(bound[0].ariaLabel!, /Анна/);
  assert.match(bound[1].ariaLabel!, /Борис/);
  assert.deepEqual(bound[0].data?.route, previous.edges[0].data?.route);
  assert.deepEqual(input.geometry, updatedInput.geometry);
});
