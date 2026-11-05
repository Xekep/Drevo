import assert from "node:assert/strict";
import test from "node:test";
import { acquireGpuProgram } from "../src/components/tree/gpu-program.ts";

function fixture() {
  let created = 0,
    deleted = 0,
    shadersDeleted = 0,
    compile = true;
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    createProgram: () => ({ id: ++created }),
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => compile,
    getShaderInfoLog: () => "compile failed",
    attachShader() {},
    deleteShader() {
      shadersDeleted++;
    },
    linkProgram() {},
    getProgramParameter: () => true,
    deleteProgram() {
      deleted++;
    },
  } as unknown as WebGL2RenderingContext;
  return {
    gl,
    fail: () => {
      compile = false;
    },
    recover: () => {
      compile = true;
    },
    counts: () => ({ created, deleted, shadersDeleted }),
  };
}

test("overlapping GPU layouts retain shaders until the final scene releases ownership", () => {
  const f = fixture();
  const old = acquireGpuProgram(f.gl, "vertex", "fragment");
  const next = acquireGpuProgram(f.gl, "vertex", "fragment");
  assert.equal(old.program, next.program);
  assert.equal(f.counts().created, 1);
  old.release();
  old.release();
  assert.equal(f.counts().deleted, 0);
  const interrupted = acquireGpuProgram(f.gl, "vertex", "fragment");
  next.release();
  assert.equal(f.counts().deleted, 0);
  interrupted.release();
  assert.equal(f.counts().deleted, 1);
  const rebuilt = acquireGpuProgram(f.gl, "vertex", "fragment");
  assert.notEqual(rebuilt.program, old.program);
  rebuilt.release();
  assert.deepEqual(f.counts(), { created: 2, deleted: 2, shadersDeleted: 4 });
});

test("compilation failure releases GPU resources and does not poison another context or a retry", () => {
  const f = fixture();
  f.fail();
  assert.throws(
    () => acquireGpuProgram(f.gl, "vertex", "fragment"),
    /compile failed/,
  );
  assert.deepEqual(f.counts(), { created: 1, deleted: 1, shadersDeleted: 1 });
  f.recover();
  const recovered = acquireGpuProgram(f.gl, "vertex", "fragment");
  const other = fixture(),
    isolated = acquireGpuProgram(other.gl, "vertex", "fragment");
  assert.notEqual(isolated.program, recovered.program);
  recovered.release();
  isolated.release();
  assert.equal(f.counts().deleted, 2);
  assert.equal(other.counts().deleted, 1);
});
