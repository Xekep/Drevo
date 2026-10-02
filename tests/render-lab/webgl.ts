import type { PersonNodeType } from "../../src/components/tree/person-node";
import type { RelationshipEdgeType } from "../../src/components/tree/relationship-edge";
import { fullName } from "../../src/domain/dates";
import { roundedRoute } from "../../src/domain/edge-routing";
import type { Viewport } from "@xyflow/react";

type Batch = { texture: WebGLTexture; buffer: WebGLBuffer; count: number };
const ATLAS = 2048,
  CELL = 136,
  COLUMNS = Math.floor(ATLAS / CELL);

/** Measurement prototype: static world buffers, bounded atlases, one camera uniform.
 * No React Flow, CSS transforms, text rasterization or texture uploads during motion.
 * Interactive controls, accessibility, shadows and production fallback are out of scope.
 */
export async function webglScene(
  canvas: HTMLCanvasElement,
  nodes: PersonNodeType[],
  edges: RelationshipEdgeType[],
) {
  const started = performance.now();
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: true })!;
  if (!gl) throw new Error("WebGL2 unavailable");
  const program = gl.createProgram()!;
  const shader = (type: number, source: string) => {
    const result = gl.createShader(type)!;
    gl.shaderSource(result, source);
    gl.compileShader(result);
    gl.attachShader(program, result);
    gl.deleteShader(result);
  };
  shader(
    gl.VERTEX_SHADER,
    `#version 300 es
    in vec2 position; in vec2 uv; in vec3 color; in vec2 range;
    uniform vec3 camera; uniform vec2 viewport;
    out vec2 texCoord; out vec3 tint;
    void main() {
      vec2 p = position * camera.z + camera.xy;
      gl_Position = vec4(p.x / viewport.x * 2. - 1., 1. - p.y / viewport.y * 2., 0., 1.);
      if(camera.z < range.x || camera.z >= range.y) gl_Position = vec4(2.,2.,0.,1.);
      texCoord = uv; tint = color;
    }`,
  );
  shader(
    gl.FRAGMENT_SHADER,
    `#version 300 es
    precision mediump float; in vec2 texCoord; in vec3 tint;
    uniform sampler2D atlas; out vec4 outputColor;
    void main() { outputColor = texture(atlas, texCoord) * vec4(tint, 1.); }`,
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) || "shader link failed");
  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const cameraUniform = gl.getUniformLocation(program, "camera");
  gl.uniform2f(
    gl.getUniformLocation(program, "viewport"),
    canvas.clientWidth,
    canvas.clientHeight,
  );
  gl.viewport(0, 0, canvas.width, canvas.height);
  const batches: Batch[] = [];
  let textureBytes = 0,
    bufferBytes = 0;
  const upload = (atlas: HTMLCanvasElement, vertices: number[]) => {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.generateMipmap(gl.TEXTURE_2D);
    const data = new Float32Array(vertices),
      buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    textureBytes += Math.ceil((atlas.width * atlas.height * 4 * 4) / 3);
    bufferBytes += data.byteLength;
    batches.push({ texture, buffer, count: data.length / 9 });
  };
  const surface = (width: number, height: number) => {
    const atlas = document.createElement("canvas");
    atlas.width = width;
    atlas.height = height;
    return atlas;
  };
  const quad = (
    data: number[],
    x: number,
    y: number,
    width: number,
    height: number,
    u: number,
    v: number,
    uw: number,
    vh: number,
    color = [1, 1, 1],
    range = [0, 10],
  ) => {
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [0, 1],
      [1, 0],
      [1, 1],
    ])
      data.push(
        x + dx * width,
        y + dy * height,
        u + dx * uw,
        v + dy * vh,
        ...color,
        ...range,
      );
  };
  // Rounded paths and crossing gaps are taken from the SAME production edge adapter.
  const lines: number[] = [];
  for (const edge of edges) {
    const path = edge.data?.path || roundedRoute(edge.data!.route!.points).path;
    const tokens = path.match(/[A-Za-z]|-?\d*\.?\d+(?:e[+-]?\d+)?/g) || [];
    const color = String(edge.style?.stroke || "#58775a")
      .slice(1)
      .match(/../g)!
      .map((hex) => parseInt(hex, 16) / 255);
    const dash = String(edge.style?.strokeDasharray || "")
      .split(/[ ,]+/)
      .map(Number)
      .filter(Boolean);
    let index = 0,
      point = [0, 0],
      distance = 0;
    const segment = (end: number[]) => {
      const dx = end[0] - point[0],
        dy = end[1] - point[1],
        length = Math.hypot(dx, dy);
      if (!length) return;
      const half = (Number(edge.style?.strokeWidth) || 1.6) / 2;
      const nx = (-dy / length) * half,
        ny = (dx / length) * half;
      let offset = 0;
      while (offset < length) {
        let step = length - offset,
          paint = true;
        if (dash.length) {
          const cycle = dash.reduce((sum, value) => sum + value, 0);
          let phase = (distance + offset) % cycle,
            slot = 0;
          while (phase >= dash[slot]) {
            phase -= dash[slot];
            slot++;
          }
          step = Math.min(step, dash[slot] - phase);
          paint = slot % 2 === 0;
        }
        if (paint) {
          const a = [
            point[0] + (dx * offset) / length,
            point[1] + (dy * offset) / length,
          ];
          const b = [
            point[0] + (dx * (offset + step)) / length,
            point[1] + (dy * (offset + step)) / length,
          ];
          for (const [p, sign] of [
            [a, 1],
            [b, 1],
            [a, -1],
            [a, -1],
            [b, 1],
            [b, -1],
          ] as [number[], number][])
            lines.push(
              p[0] + sign * nx,
              p[1] + sign * ny,
              0.5,
              0.5,
              ...color,
              0,
              10,
            );
        }
        offset += Math.max(step, 0.00001);
      }
      point = end;
      distance += length;
    };
    while (index < tokens.length) {
      const command = tokens[index++];
      if (command === "M") {
        point = [+tokens[index++], +tokens[index++]];
        distance = 0;
      } else if (command === "L") segment([+tokens[index++], +tokens[index++]]);
      else if (command === "Q") {
        const control = [+tokens[index++], +tokens[index++]],
          end = [+tokens[index++], +tokens[index++]],
          start = point;
        for (let step = 1; step <= 8; step++) {
          const t = step / 8,
            s = 1 - t;
          segment([
            s * s * start[0] + 2 * s * t * control[0] + t * t * end[0],
            s * s * start[1] + 2 * s * t * control[1] + t * t * end[1],
          ]);
        }
      } else throw new Error(`unsupported route command ${command}`);
    }
  }
  const white = surface(1, 1);
  white.getContext("2d")!.fillRect(0, 0, 1, 1);
  white.getContext("2d")!.fillStyle = "white";
  white.getContext("2d")!.fillRect(0, 0, 1, 1);
  upload(white, lines);
  // A single shared glyph atlas. Names are prepared once for the three existing LODs.
  const font = surface(1024, 1024),
    context = font.getContext("2d")!;
  context.font = "600 29px Georgia";
  context.fillStyle = "#253a2c";
  context.textBaseline = "top";
  const glyphs = new Map<string, { x: number; y: number; width: number }>();
  let gx = 2,
    gy = 2;
  for (const letter of new Set(
    nodes.flatMap((node) => [...fullName(node.data.person)]),
  )) {
    const width = Math.ceil(context.measureText(letter).width) + 4;
    if (gx + width > 1024) {
      gx = 2;
      gy += 40;
    }
    if (gy + 40 > 1024) throw new Error("glyph atlas full");
    context.fillText(letter, gx + 2, gy);
    glyphs.set(letter, { x: gx, y: gy, width });
    gx += width;
  }
  const text: number[] = [];
  for (const node of nodes)
    for (const [size, low, high] of [
      [29, 0, 0.18],
      [22, 0.18, 0.52],
      [16, 0.52, 10],
    ]) {
      const scale = size / 29,
        name = fullName(node.data.person);
      const widths = [...name].map(
        (letter) => (glyphs.get(letter)!.width - 4) * scale,
      );
      const total = widths.reduce((sum, value) => sum + value, 0);
      const fit = Math.min(1, (node.width! - 16) / total);
      let x = node.position.x + (node.width! - total * fit) / 2;
      [...name].forEach((letter, index) => {
        const glyph = glyphs.get(letter)!;
        quad(
          text,
          x - 2 * scale * fit,
          node.position.y + 146,
          glyph.width * scale * fit,
          40 * scale,
          glyph.x / 1024,
          glyph.y / 1024,
          glyph.width / 1024,
          40 / 1024,
          [1, 1, 1],
          [low, high],
        );
        x += widths[index] * fit;
      });
    }
  upload(font, text);
  // Portraits: bounded atlas pages, decoded one at a time, no retained 400px image objects.
  for (let first = 0; first < nodes.length; first += COLUMNS * COLUMNS) {
    const count = Math.min(COLUMNS * COLUMNS, nodes.length - first);
    const rows = Math.ceil(count / COLUMNS),
      atlas = surface(ATLAS, rows * CELL),
      ctx = atlas.getContext("2d")!;
    const vertices: number[] = [];
    for (let offset = 0; offset < count; offset++) {
      const node = nodes[first + offset],
        x = (offset % COLUMNS) * CELL + 2,
        y = Math.floor(offset / COLUMNS) * CELL + 2;
      const image = new Image();
      image.src = `${node.data.person.photo}?variant=thumb`;
      await image.decode();
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + 66, y + 66, 66, 0, Math.PI * 2);
      ctx.clip();
      ctx.filter = "grayscale(1)";
      ctx.drawImage(image, x, y, 132, 132);
      ctx.restore();
      ctx.strokeStyle = node.data.person.needsReview ? "#d77b18" : "#fffefa";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x + 66, y + 66, 64.5, 0, Math.PI * 2);
      ctx.stroke();
      quad(
        vertices,
        node.position.x + (node.width! - 132) / 2,
        node.position.y + 4,
        132,
        132,
        x / atlas.width,
        y / atlas.height,
        132 / atlas.width,
        132 / atlas.height,
      );
    }
    upload(atlas, vertices);
  }
  const attributes = (
    [
      ["position", 2, 0],
      ["uv", 2, 2],
      ["color", 3, 4],
      ["range", 2, 7],
    ] as const
  ).map(([name, size, offset]) => ({
    location: gl.getAttribLocation(program, name),
    size,
    offset,
  }));
  const setupMs = Math.round(performance.now() - started);
  let draws = 0;
  const draw = ({ x, y, zoom }: Viewport) => {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform3f(cameraUniform, x, y, zoom);
    for (const batch of batches) {
      gl.bindTexture(gl.TEXTURE_2D, batch.texture);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
      for (const { location, size, offset } of attributes) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 36, offset * 4);
      }
      gl.drawArrays(gl.TRIANGLES, 0, batch.count);
    }
    draws++;
  };
  return {
    draw,
    stats: () => ({
      setupMs,
      textureBytes,
      bufferBytes,
      batches: batches.length,
      draws,
      error: gl.getError(),
    }),
    destroy: () => {
      for (const batch of batches) {
        gl.deleteTexture(batch.texture);
        gl.deleteBuffer(batch.buffer);
      }
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
