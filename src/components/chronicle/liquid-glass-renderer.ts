import { liquidGlassFragment } from "./liquid-glass-shader";

/** Owns one canvas, two reusable textures and no animation loop. */
export function createLiquidGlassRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: "low-power",
  });
  if (!gl) throw new Error("WebGL недоступен");
  const shaders: WebGLShader[] = [],
    textures: WebGLTexture[] = [];
  const program = gl.createProgram(),
    buffer = gl.createBuffer();
  function dispose(releaseContext = false) {
    textures.forEach((texture) => gl!.deleteTexture(texture));
    shaders.forEach((shader) => gl!.deleteShader(shader));
    gl!.deleteBuffer(buffer);
    gl!.deleteProgram(program);
    if (releaseContext) gl!.getExtension("WEBGL_lose_context")?.loseContext();
  }
  try {
    if (!program || !buffer) throw new Error("Не удалось создать переход");
    for (const [type, source] of [
      [
        gl.VERTEX_SHADER,
        "attribute vec2 position; varying vec2 vUv; void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }",
      ],
      [gl.FRAGMENT_SHADER, liquidGlassFragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Не удалось создать шейдер");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Шейдер не поддерживается");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("Переход не поддерживается");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const resolution = gl.getUniformLocation(program, "uResolution");
    const progress = gl.getUniformLocation(program, "uProgress");
    const sizes = [1, 2].map((i) =>
      gl.getUniformLocation(program, `uTexture${i}Size`),
    );
    for (let i = 0; i < 2; i++) {
      const texture = gl.createTexture();
      if (!texture) throw new Error("Не удалось создать текстуру");
      textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.uniform1i(gl.getUniformLocation(program, `uTexture${i + 1}`), i);
    }
    const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    return {
      prepare(from: HTMLImageElement, to: HTMLImageElement) {
        [from, to].forEach((image, i) => {
          if (Math.max(image.naturalWidth, image.naturalHeight) > maximum)
            throw new Error("Снимок слишком велик для перехода");
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, textures[i]);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            image,
          );
          gl.uniform2f(sizes[i], image.naturalWidth, image.naturalHeight);
        });
        if (gl.getError() !== gl.NO_ERROR)
          throw new Error("Не удалось загрузить снимок в переход");
      },
      render(value: number) {
        if (gl.isContextLost()) throw new Error("Контекст перехода потерян");
        const { width, height } = canvas.getBoundingClientRect();
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          1.5,
          Math.sqrt(1_500_000 / Math.max(1, width * height)),
        );
        const w = Math.max(1, Math.round(width * ratio)),
          h = Math.max(1, Math.round(height * ratio));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
        gl.uniform2f(resolution, width, height);
        gl.uniform1f(progress, value);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
