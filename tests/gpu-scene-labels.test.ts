import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGpuScene } from "../src/components/tree/gpu-scene.ts";
import type { PersonNodeType } from "../src/components/tree/person-node.tsx";

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let programs = 0, redraws = 0, glyphUploads = 0;
  const constants = new Map<string, number>([["NO_ERROR", 0]]);
  const methods: Record<string, unknown> = {
    getExtension: () => null,
    getParameter: () => 8192,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getError: () => 0,
    createProgram: () => ({ program: ++programs }),
    texImage2D: () => { glyphUploads++; },
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
  const fontCanvas = () => ({ width: 0, height: 0, getContext: () => ({
    measureText: () => ({ width: 32 }), fillText: () => {},
  }) });
  for (const [key, value] of Object.entries({
    document: { createElement: fontCanvas }, window: { devicePixelRatio: 1 },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const canvas = { width: 800, height: 600, dataset: {} as Record<string, string>, getContext: () => gl };
  const nodes = Array.from({ length: 70 }, (_, index) => ({
    id: `n${index}`, type: "person", position: { x: index * 230, y: 0 }, width: 220, height: 264,
    data: { collapsed: false, childrenCount: 0, dimmed: false, person: { id: `p${index}`, name: "Name", surname: "Test", patronymic: "", sex: "m",
      birth: "1900", birthPlace: "", parents: [], spouses: [], sources: [], generation: 1, column: index } },
  })) as PersonNodeType[];
  const create = (read: (node: PersonNodeType) => string) => {
    const scene = createGpuScene(canvas as unknown as HTMLCanvasElement, nodes, [], [], read,
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
    glyphUploads: () => glyphUploads };
}

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
