type SharedProgram = { program: WebGLProgram; users: number };
const contexts = new WeakMap<
  WebGL2RenderingContext,
  Map<string, SharedProgram>
>();

/** Overlapping geometry scenes share compiled shaders, with explicit ownership. */
export function acquireGpuProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
) {
  let cache = contexts.get(gl);
  if (!cache) contexts.set(gl, (cache = new Map()));
  const key = vertex + "\0" + fragment;
  let shared = cache.get(key);
  if (!shared) {
    const program = gl.createProgram();
    if (!program) throw new Error("GPU program allocation failed");
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("GPU shader allocation failed");
        try {
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error(
              gl.getShaderInfoLog(shader) || "GPU shader compilation failed",
            );
          gl.attachShader(program, shader);
        } finally {
          gl.deleteShader(shader);
        }
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(
          gl.getProgramInfoLog(program) || "GPU shader link failed",
        );
      shared = { program, users: 0 };
      cache.set(key, shared);
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    }
  }
  const owned = shared;
  owned.users++;
  let released = false;
  return {
    program: owned.program,
    release() {
      if (released) return;
      released = true;
      if (--owned.users === 0) {
        cache.delete(key);
        gl.deleteProgram(owned.program);
      }
    },
  };
}
