import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGpuScene } from "../src/components/tree/gpu-scene.ts";
import type { PersonNodeType } from "../src/components/tree/person-node.tsx";
import type { RelationshipEdgeType } from "../src/components/tree/relationship-edge.tsx";

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let programs = 0, redraws = 0, glyphUploads = 0;
  const uploads: Float32Array[] = [];
  const details: number[] = [];
  const constants = new Map<string, number>([["NO_ERROR", 0]]);
  const methods: Record<string, unknown> = {
    getExtension: () => null,
    getParameter: () => 8192,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getError: () => 0,
    createProgram: () => ({ program: ++programs }),
    getUniformLocation: (_program: unknown, name: string) => name,
    uniform1f: (name: string, value: number) => { if (name === "labelDetail") details.push(value); },
    bufferData: (_target: number, data: Float32Array) => uploads.push(data.slice()),
    texImage2D: (_target: number, _level: number, format: number) => {
      if (format === constants.get("R8")) glyphUploads++;
    },
  };
  const gl = new Proxy(methods, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (/^[A-Z_0-9]+$/.test(key)) {
        if (!constants.has(key)) constants.set(key, constants.size);
        return constants.get(key);
      }
      return key.startsWith("create") ? () => ({}) : () => {};
    },
  });
  const context = new Proxy({
    measureText: () => ({ width: 32, actualBoundingBoxAscent: 48, actualBoundingBoxDescent: 8,
      actualBoundingBoxLeft: 0, actualBoundingBoxRight: 32, fontBoundingBoxAscent: 60, fontBoundingBoxDescent: 16 }),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (() => {}) });
  const fontCanvas = () => ({ width: 0, height: 0, getContext: () => context });
  for (const [key, value] of Object.entries({
    document: { createElement: fontCanvas }, window: { devicePixelRatio: 1 },
    Path2D: class {},
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const canvas = { width: 800, height: 600, style: {}, dataset: {} as Record<string, string>, getContext: () => gl };
  const nodes = Array.from({ length: 70 }, (_, index) => ({
    id: `n${index}`, type: "person", position: { x: index * 230, y: 0 }, width: 220, height: 264,
    data: { collapsed: false, childrenCount: 0, dimmed: false, person: { id: `p${index}`, name: "Name", surname: "Test", patronymic: "", sex: "m",
      birth: "1900", birthPlace: "", parents: [], spouses: [], sources: [], generation: 1, column: index } },
  })) as PersonNodeType[];
  const create = (read: (node: PersonNodeType) => string, edges: RelationshipEdgeType[] = []) => {
    const scene = createGpuScene(canvas as unknown as HTMLCanvasElement, nodes, edges, [], read,
      () => { redraws++; }, () => assert.fail("unexpected GPU failure"));
    t.after(() => scene.destroy());
    return scene;
  };
  const finish = () => {
    for (let index = 0; index < 500 && canvas.dataset.gpuRelationsReady !== "true"; index++)
      t.mock.timers.tick(1);
    assert.equal(canvas.dataset.gpuRelationsReady, "true");
  };
  return { create, nodes, canvas, finish, programs: () => programs, redraws: () => redraws,
    glyphUploads: () => glyphUploads, uploads, details };
}

test("name enlargement and detail fade use one zoom value and preserve the text layout", t => {
  const setup = fixture(t);
  setup.nodes[1].data.person.surname = "Оченьдлиннаядвойнаяфамилия";
  setup.nodes[1].data.person.patronymic = "Константинович";
  const scene = setup.create(() => "двоюродный брат");
  const draw = (zoom: number) => scene.draw({ x: 0, y: 0, zoom }, 800, 600);
  draw(0.45);
  setup.finish();
  draw(0.45);
  const textUploads = () => setup.uploads.filter(data => data[14] < 0 || data[14] === 130);
  const text = textUploads().find(data => data[14] < 0)!;
  const instances = (data: Float32Array) =>
    Array.from({ length: data.length / 16 }, (_, i) => data.subarray(i * 16, (i + 1) * 16));
  const quads = instances(text);
  const relations = textUploads().filter(data => data[14] === 130).flatMap(instances);
  for (const { position } of setup.nodes.slice(0, 2)) {
    const center = position.x + 110;
    const names = quads.filter(q => q[14] < 0 && q[8] === center);
    assert.ok(names.length > 0);
    const scale = -names[0][14];
    assert.ok(scale > 1 && scale <= 28 / 22 + 1e-6);
    if (position.x === 0) assert.ok(Math.abs(scale - 28 / 22) < 1e-6);
    else assert.ok(scale < 28 / 22 - 0.01);
    for (const glyph of names) {
      const [x, , width] = glyph;
      assert.equal(glyph[14], -scale, "all glyphs of a name scale together");
      assert.equal(glyph[9], 146);
      assert.ok(center + (x - center) * scale >= position.x + 6 - 1e-4);
      assert.ok(center + (x + width - center) * scale <= position.x + 214 + 1e-4);
    }
    const dates = quads.find(q => q[14] === 130 && Math.abs(q[0] - center) < 55)!;
    const lines = position.x === 0 ? 1 : 2;
    assert.ok(Math.abs(dates[8] - lines * 24 * (scale - 1)) < 1e-5);
    assert.ok(relations.some(glyph => Math.abs(glyph[0] - center) < 55 && Math.abs(glyph[8] - dates[8]) < 1e-5));
  }
  const count = textUploads().length;
  assert.equal(setup.details.at(-1), 1);
  const zooms = [0.4, 0.39, 0.29, 0.19, 0.18];
  for (const zoom of zooms) draw(zoom);
  const [above, start, middle, end, below] = setup.details.slice(-zooms.length);
  assert.equal(above, 1);
  assert.ok(start < 1 && start > middle);
  assert.ok(Math.abs(middle - 0.5) < 1e-12);
  assert.ok(end > 0 && end < middle);
  assert.equal(below, 0);
  assert.equal(textUploads().length, count, "zoom inside one LOD does not upload glyph geometry");
  draw(0.17);
  assert.equal(setup.details.at(-1), 0);
  assert.equal(setup.canvas.dataset.gpuLabelLod, "0");
  const distant = textUploads().at(-1)!;
  assert.equal(distant.length, 16 * quads.filter(q => q[14] < 0).length);
  let index = 0;
  for (const glyph of quads.filter(q => q[14] < 0)) {
    assert.deepEqual(distant.subarray(index, index + 16), glyph);
    index += 16;
  }
});

test("zoom-dependent crossing paths update GPU lines without rebuilding text or programs", t => {
  const setup = fixture(t), read = () => "";
  const edge = { id: "edge", source: "n0", target: "n1", data: { path: "M0,0 L20,20" } } as RelationshipEdgeType;
  const scene = setup.create(read, [edge]);
  scene.draw({ x: 0, y: 0, zoom: 0.3 }, 800, 600);
  setup.finish();
  const programs = setup.programs(), glyphs = setup.glyphUploads();
  const next = { ...edge, data: { ...edge.data, path: "M0,0 L30,30" } } as RelationshipEdgeType;
  const before = setup.uploads.length;
  assert.equal(scene.update(setup.nodes, [next], [], read), true);
  assert.ok(setup.uploads.slice(before).some(data => data.length === 12 && data[2] === 30 && data[3] === 30));
  const after = setup.uploads.length;
  assert.equal(scene.update(setup.nodes, [next], [], read), true);
  assert.equal(setup.uploads.length, after, "unchanged routes do not upload again");
  assert.equal(setup.programs(), programs);
  assert.equal(setup.glyphUploads(), glyphs);
});

test("first GPU frame skips cold relations and completed labels reuse the scene", t => {
  const setup = fixture(t);
  let reads = 0;
  const scene = setup.create(() => { reads++; return "брат"; });
  assert.equal(reads, 0);
  scene.draw({ x: 0, y: 0, zoom: 0.3 }, 800, 600);
  assert.equal(reads, 0, "the first frame must not search kinship");
  const initialBytes = Number(setup.canvas.dataset.gpuLabelBytes);
  const programs = setup.programs();
  t.mock.timers.tick(1);
  assert.ok(reads > 0 && reads <= 32);
  assert.equal(setup.canvas.dataset.gpuRelationsReady, "false");
  setup.finish();
  assert.equal(reads, setup.nodes.length);
  scene.draw({ x: 0, y: 0, zoom: 0.3 }, 800, 600);
  assert.ok(Number(setup.canvas.dataset.gpuLabelBytes) > initialBytes);
  assert.equal(setup.programs(), programs, "labels do not recreate shader programs");
  assert.ok(setup.redraws() > 0);
});

test("changing the reference discards stale work and clears old GPU labels", t => {
  const setup = fixture(t);
  let oldReads = 0, nextReads = 0;
  const scene = setup.create(() => { oldReads++; return "брат"; });
  scene.draw({ x: 0, y: 0, zoom: 0.6 }, 800, 600);
  const baseBytes = Number(setup.canvas.dataset.gpuLabelBytes);
  t.mock.timers.tick(1);
  const oldAtChange = oldReads;
  // Reuse glyphs produced by the cancelled job before they reached the atlas.
  const next = () => { nextReads++; return "брат"; };
  assert.equal(scene.update(setup.nodes, [], [], next), true);
  assert.equal(nextReads, 0, "changing reference must not calculate during update");
  setup.finish();
  assert.equal(oldReads, oldAtChange);
  assert.equal(nextReads, setup.nodes.length);
  assert.equal(setup.glyphUploads(), 2);
  scene.draw({ x: 0, y: 0, zoom: 0.6 }, 800, 600);
  assert.ok(Number(setup.canvas.dataset.gpuLabelBytes) > baseBytes);
  assert.equal(scene.update(setup.nodes, [], [], () => ""), true);
  scene.draw({ x: 0, y: 0, zoom: 0.6 }, 800, 600);
  assert.equal(Number(setup.canvas.dataset.gpuLabelBytes), baseBytes,
    "old reference labels disappear before its replacement completes");
  setup.finish();
  scene.draw({ x: 0, y: 0, zoom: 0.6 }, 800, 600);
  assert.equal(Number(setup.canvas.dataset.gpuLabelBytes), baseBytes);
  assert.equal(setup.glyphUploads(), 2, "empty labels do not reupload the atlas");
});

test("destroy cancels pending label searches and their redraw", t => {
  const setup = fixture(t);
  let reads = 0;
  const scene = setup.create(() => { reads++; return "брат"; });
  scene.draw({ x: 0, y: 0, zoom: 0.3 }, 800, 600);
  t.mock.timers.tick(1);
  const readsBefore = reads, redrawsBefore = setup.redraws();
  scene.destroy();
  t.mock.timers.tick(1000);
  assert.equal(reads, readsBefore);
  assert.equal(setup.redraws(), redrawsBefore);
});
