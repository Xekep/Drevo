import type { Viewport } from "@xyflow/react";
import { fullName, years, resolvedSex } from "../../domain";
import { roundedRoute, Spatial, type Box } from "../../domain/edge-routing";
import type { PersonNodeType } from "./person-node";
import type { RelationshipEdgeType } from "./relationship-edge";
import type { HouseholdNodeType } from "./household-node";
import { GpuPortraitCache } from "./gpu-portrait-cache";
import { gpuRoute } from "./gpu-route";

const MAX_BUFFERS = 24 * 1024 * 1024;
const FONT_SIZE = 1024;
const FONT = '"Segoe UI Variable Text", "Segoe UI", sans-serif';
type Batch = { buffer: WebGLBuffer; count: number };
type Glyph = { x: number; y: number; width: number; advance: number };
type IndexedNode = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  node: PersonNodeType;
};

/** World coordinates remain unchanged at every zoom. React Flow owns the camera. */
export function createGpuScene(
  canvas: HTMLCanvasElement,
  nodes: readonly PersonNodeType[],
  edges: readonly RelationshipEdgeType[],
  households: readonly HouseholdNodeType[],
  relationLabel: (node: PersonNodeType) => string,
  redraw: () => void,
  failure: () => void,
  previousPortraits?: GpuPortraitCache,
) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL2 unavailable");
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (
    info &&
    /swiftshader|llvmpipe|software/i.test(
      String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)),
    )
  )
    throw new Error("Software WebGL renderer");
  const maxDrawingSize = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  const buffers: WebGLBuffer[] = [],
    textures: WebGLTexture[] = [],
    programs: WebGLProgram[] = [];
  let portraits: GpuPortraitCache | undefined,
    bufferBytes = 0,
    disposed = false;
  const destroy = (preservePortraits = false) => {
    if (disposed) return;
    disposed = true;
    if (!preservePortraits) portraits?.destroy();
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    for (const texture of textures) gl.deleteTexture(texture);
    for (const program of programs) gl.deleteProgram(program);
  };
  try {
    const program = (vertex: string, fragment: string) => {
      const result = gl.createProgram()!;
      programs.push(result);
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const error = gl.getShaderInfoLog(shader);
          gl.deleteShader(shader);
          throw new Error(error || "GPU shader compilation failed");
        }
        gl.attachShader(result, shader);
        gl.deleteShader(shader);
      }
      gl.linkProgram(result);
      if (!gl.getProgramParameter(result, gl.LINK_STATUS))
        throw new Error(
          gl.getProgramInfoLog(result) || "GPU shader link failed",
        );
      return result;
    };
    const cameraShader = `uniform vec3 camera; uniform vec2 viewport;
      vec4 project(vec2 world) { vec2 p=world*camera.z+camera.xy;
        return vec4(p.x/viewport.x*2.-1.,1.-p.y/viewport.y*2.,0.,1.); }
      const vec2 corners[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));`;
    const spriteProgram = program(
      `#version 300 es
      precision highp float; precision highp int;
      layout(location=0) in vec4 rect; layout(location=1) in vec4 uv;
      layout(location=2) in vec2 range; layout(location=3) in vec4 color;
      layout(location=4) in float kind;
      ${cameraShader}
      out vec2 texCoord; out vec2 local; out vec4 tint; flat out int mode; flat out vec2 dimensions;
      void main() { vec2 c=corners[gl_VertexID]; gl_Position=project(rect.xy+c*rect.zw);
        if(camera.z<range.x || camera.z>=range.y) gl_Position=vec4(2,2,0,1);
        texCoord=uv.xy+c*uv.zw; local=c; tint=color; mode=int(kind); dimensions=rect.zw; }`,
      `#version 300 es
      precision highp float; precision highp int;
      in vec2 texCoord; in vec2 local; in vec4 tint; flat in int mode; flat in vec2 dimensions;
      uniform sampler2D atlas; out vec4 outputColor;
      void main() {
        if(mode==128) { float r=length((local-.5)*2.); outputColor=vec4(tint.rgb,(1.-smoothstep(0.,1.,r))*tint.a); return; }
        if(mode==129) { vec2 q=abs((local-.5)*dimensions)-dimensions*.5+14.;
          float d=length(max(q,vec2(0)))+min(max(q.x,q.y),0.)-14.; float aa=max(fwidth(d),.4);
          float border=smoothstep(-1.5-aa,-1.5+aa,d); outputColor=vec4(tint.rgb,
            mix(.035,.55,border)*(1.-smoothstep(-aa,aa,d))); return; }
        if(mode==0) { outputColor=vec4(tint.rgb,texture(atlas,texCoord).a*tint.a); return; }
        if(mode==64) { float r=length(local-.5)*2.; outputColor=vec4(tint.rgb,(1.-smoothstep(.85,1.,r))*tint.a); return; }
        // The quad includes eight world pixels of shadow around the 132px circle.
        float d=length((local-.5)*148.); float aa=max(fwidth(d),.35);
        vec4 result=vec4(.16,.24,.20,exp(-pow(max(d-65.,0.)/4.,2.))*.16*tint.a);
        if(d<=66.+aa) {
          vec2 photoUv=texCoord;
          vec3 base=tint.rgb;
          if((mode&1)!=0) { vec3 rgb=texture(atlas,photoUv).rgb; base=vec3((mode&32)!=0 ? rgb.r : dot(rgb,vec3(.2126,.7152,.0722))); }
          else { vec2 p=(local-.5)*148.;
            if(length(p-vec2(0,-15))<17. || (p.y>8. && length((p-vec2(0,47))/vec2(40,42))<1.)) base=vec3(.51,.61,.54); }
          vec3 ring=(mode&2)!=0 ? vec3(.84,.48,.09) : vec3(1.,.996,.98);
          base=mix(base,ring,smoothstep(63.-aa,63.+aa,d));
          result=vec4(base,(1.-smoothstep(66.-aa,66.+aa,d))*tint.a);
        }
        if((mode&12)!=0 && d>66.) {
          vec3 ring=(mode&4)!=0 ? vec3(.36,.52,.31) : vec3(.57,.61,.31);
          float coverage=(1.-smoothstep(70.-aa,70.+aa,d))*smoothstep(66.-aa,66.+aa,d);
          result=mix(result,vec4(ring,tint.a),coverage);
        }
        outputColor=result;
      }`,
    );
    const lineProgram = program(
      `#version 300 es
      precision highp float;
      layout(location=0) in vec4 ends; layout(location=1) in vec2 stroke;
      layout(location=2) in vec2 dash; layout(location=3) in vec4 color;
      ${cameraShader}
      out float along; out vec4 tint; flat out vec2 pattern;
      void main() { vec2 c=corners[gl_VertexID], delta=ends.zw-ends.xy;
        float len=length(delta); vec2 normal=vec2(-delta.y,delta.x)/max(len,.001);
        vec2 point=mix(ends.xy,ends.zw,c.x)+normal*(c.y-.5)*max(stroke.x,.4/camera.z);
        gl_Position=project(point); along=stroke.y+c.x*len; tint=color; pattern=dash; }`,
      `#version 300 es
      precision highp float;
      in float along; in vec4 tint; flat in vec2 pattern; out vec4 outputColor;
      void main() { if(pattern.y>0. && mod(along,pattern.x+pattern.y)>pattern.x) discard;
        outputColor=tint; }`,
    );
    const cameraUniforms = [spriteProgram, lineProgram].map((p) => ({
      camera: gl.getUniformLocation(p, "camera"),
      viewport: gl.getUniformLocation(p, "viewport"),
    }));
    const makeBuffer = (data: number[], stride: number): Batch => {
      const array = new Float32Array(data);
      bufferBytes += array.byteLength;
      if (bufferBytes > MAX_BUFFERS)
        throw new Error("GPU geometry budget exceeded");
      const buffer = gl.createBuffer()!;
      buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
      return { buffer, count: array.length / stride };
    };
    const color = (value: unknown, fallback = "#58775a") => {
      const hex = /^#[a-f\d]{6}$/i.test(String(value))
        ? String(value)
        : fallback;
      return hex
        .slice(1)
        .match(/../g)!
        .map((part) => parseInt(part, 16) / 255);
    };
    const lines: number[] = [],
      junctions: number[] = [];
    for (const edge of edges) {
      const path =
        edge.data?.path ||
        (edge.data?.route && roundedRoute(edge.data.route.points).path);
      if (!path) throw new Error("GPU edge has no routed geometry");
      const rgb = color(edge.style?.stroke);
      const dash = String(edge.style?.strokeDasharray || "")
        .split(/[ ,]+/)
        .map(Number)
        .filter(Boolean);
      if (dash.length > 2) throw new Error("Unsupported GPU dash pattern");
      for (const segment of gpuRoute(path))
        lines.push(
          segment.ax,
          segment.ay,
          segment.bx,
          segment.by,
          Number(edge.style?.strokeWidth) || 1.6,
          segment.distance,
          dash[0] || 0,
          dash[1] || dash[0] || 0,
          ...rgb,
          Number(edge.style?.opacity ?? 1),
        );
      if (edge.data?.junction)
        junctions.push(
          edge.data.junction.x - 2.4,
          edge.data.junction.y - 2.4,
          4.8,
          4.8,
          0,
          0,
          0,
          0,
          0,
          10,
          ...rgb,
          1,
          64,
        );
    }
    const lineBatch = makeBuffer(lines, 12),
      junctionBatch = makeBuffer(junctions, 15);
    lines.length = 0;
    junctions.length = 0;
    const surfaces: number[] = [];
    for (const node of households)
      surfaces.push(
        node.position.x,
        node.position.y,
        node.width || 1,
        node.height || 1,
        0,
        0,
        0,
        0,
        0,
        10,
        ...(node.data.label ? [0.875, 0.902, 0.843] : [0.514, 0.592, 0.467]),
        0.08,
        node.data.label ? 129 : 128,
      );
    const surfaceBatch = makeBuffer(surfaces, 15);
    surfaces.length = 0;
    const fontCanvas = document.createElement("canvas");
    fontCanvas.width = fontCanvas.height = FONT_SIZE;
    const ctx = fontCanvas.getContext("2d")!;
    ctx.textBaseline = "top";
    ctx.fillStyle = "white";
    const glyphs = new Map<string, Glyph>();
    let gx = 2,
      gy = 2;
    const glyph = (letter: string, bold: boolean) => {
      const key = `${bold}:${letter}`;
      const cached = glyphs.get(key);
      if (cached) return cached;
      ctx.font = `${bold ? 600 : 400} 64px ${FONT}`;
      const advance = ctx.measureText(letter).width,
        width = Math.ceil(advance) + 4;
      if (gx + width > FONT_SIZE) {
        gx = 2;
        gy += 84;
      }
      if (gy + 84 > FONT_SIZE) throw new Error("GPU glyph budget exceeded");
      ctx.fillText(letter, gx + 2, gy + 2);
      const result = { x: gx, y: gy, width, advance };
      glyphs.set(key, result);
      gx += width;
      return result;
    };
    const labels: number[] = [];
    const text = (
      value: string,
      node: Pick<PersonNodeType, "position" | "width"> & {
        data: Pick<PersonNodeType["data"], "outsideSpotlight" | "dimmed">;
      },
      top: number,
      size: number,
      lineHeight: number,
      maxLines: number,
      bold: boolean,
      low: number,
      high: number,
      alignRight = false,
    ) => {
      if (!value) return 0;
      // Separate glyphs cannot shape joining scripts or combining sequences.
      // Use the native text renderer for these archives instead of corrupting names.
      if (/[\u0300-\u036f\u0590-\u0fff\u200d]/u.test(value))
        throw new Error("Native text shaping required");
      const maxWidth = (node.width || 220) - 16,
        scale = size / 64;
      const measure = (s: string) =>
        [...s].reduce((sum, c) => sum + glyph(c, bold).advance * scale, 0);
      const rows: string[] = [];
      let row = "";
      for (const letter of [...value]) {
        if (row && measure(row + letter) > maxWidth) {
          const space = row.lastIndexOf(" ");
          if (space > 0) {
            rows.push(row.slice(0, space));
            row = row.slice(space + 1) + letter;
          } else {
            rows.push(row);
            row = letter;
          }
        } else row += letter;
      }
      if (row) rows.push(row);
      if (rows.length > maxLines) {
        let last = rows[maxLines - 1];
        while (last && measure(last + "…") > maxWidth)
          last = [...last].slice(0, -1).join("");
        rows[maxLines - 1] = last + "…";
      }
      for (const [index, line] of rows.slice(0, maxLines).entries()) {
        let x =
          node.position.x +
          (alignRight
            ? (node.width || 220) - 14 - measure(line)
            : ((node.width || 220) - measure(line)) / 2);
        for (const letter of [...line]) {
          const g = glyph(letter, bold);
          labels.push(
            x - scale * 2,
            node.position.y + top + index * lineHeight,
            g.width * scale,
            84 * scale,
            g.x / FONT_SIZE,
            g.y / FONT_SIZE,
            g.width / FONT_SIZE,
            84 / FONT_SIZE,
            low,
            high,
            0.145,
            0.227,
            0.173,
            node.data.outsideSpotlight ? 0.3 : node.data.dimmed ? 0.6 : 1,
            0,
          );
          x += g.advance * scale;
        }
      }
      return Math.min(rows.length, maxLines);
    };
    for (const node of nodes) {
      const name = fullName(node.data.person),
        dates = years(node.data.person),
        relation = relationLabel(node);
      text(name, node, 146, 29, 30, 2, true, 0, 0.18);
      const overviewLines = text(name, node, 146, 22, 23, 2, true, 0.18, 0.52);
      const overviewDates = 146 + overviewLines * 23 + 4;
      text(dates, node, overviewDates, 15, 18, 1, false, 0.18, 0.52);
      text(
        relation,
        node,
        overviewDates + (dates ? 22 : 0),
        18,
        20,
        1,
        false,
        0.18,
        0.52,
      );
      const fullLines = text(name, node, 146, 16, 18, 3, true, 0.52, 10);
      const fullDates = 146 + fullLines * 18 + 4;
      text(dates, node, fullDates, 12, 16, 1, false, 0.52, 10);
      text(
        relation,
        node,
        fullDates + (dates ? 20 : 0),
        14,
        16,
        2,
        false,
        0.52,
        10,
      );
    }
    for (const node of households)
      if (node.data.label)
        text(
          node.data.label,
          { ...node, data: { dimmed: false } },
          node.data.reverse ? 5 : (node.height || 264) - 21,
          12,
          16,
          1,
          false,
          0,
          10,
          true,
        );
    const labelBatch = makeBuffer(labels, 15);
    labels.length = 0;
    glyphs.clear();
    const fontTexture = gl.createTexture()!;
    textures.push(fontTexture);
    gl.bindTexture(gl.TEXTURE_2D, fontTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      fontCanvas,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    fontCanvas.width = fontCanvas.height = 1;
    let portraitDirty = true;
    const photoDraw = () => {
      portraitDirty = true;
      redraw();
    };
    portraits =
      previousPortraits || new GpuPortraitCache(gl, photoDraw, failure);
    portraits.update(
      photoDraw,
      failure,
      new Set(
        nodes.flatMap((node) =>
          node.data.person.photo ? [node.data.person.photo] : [],
        ),
      ),
    );
    const index = new Spatial<IndexedNode>();
    let currentNodes = nodes;
    let currentNodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes)
      index.add({
        node,
        left: node.position.x,
        top: node.position.y,
        right: node.position.x + (node.width || 220),
        bottom: node.position.y + (node.height || 264),
      });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const bind = (batch: Batch, stride: number, attributes: number[]) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
      let offset = 0;
      attributes.forEach((size, location) => {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(
          location,
          size,
          gl.FLOAT,
          false,
          stride * 4,
          offset * 4,
        );
        gl.vertexAttribDivisor(location, 1);
        offset += size;
      });
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count);
    };
    let hovered = "",
      focused = "",
      draws = 0;
    let cachedBox: Box | undefined,
      cachedHigh = false;
    const portraitBatches = new Map<WebGLTexture, Batch & { bytes: number }>();
    return {
      portraits,
      ready: () => portraits!.ready(),
      // A selection changes the portrait ring only. Keep the programs, font
      // atlas and routed geometry if all their inputs remain unchanged.
      update(
        nextNodes: readonly PersonNodeType[],
        nextEdges: readonly RelationshipEdgeType[],
        nextHouseholds: readonly HouseholdNodeType[],
        nextRelationLabel: (node: PersonNodeType) => string,
      ) {
        if (
          disposed ||
          relationLabel !== nextRelationLabel ||
          currentNodes.length !== nextNodes.length ||
          edges.length !== nextEdges.length ||
          households.length !== nextHouseholds.length
        )
          return false;
        for (let i = 0; i < currentNodes.length; i++) {
          const a = currentNodes[i], b = nextNodes[i];
          if (
            a.id !== b.id ||
            a.position.x !== b.position.x ||
            a.position.y !== b.position.y ||
            a.width !== b.width ||
            a.height !== b.height ||
            a.data.person !== b.data.person ||
            a.data.dimmed !== b.data.dimmed ||
            a.data.outsideSpotlight !== b.data.outsideSpotlight
          )
            return false;
        }
        for (let i = 0; i < edges.length; i++) {
          const a = edges[i], b = nextEdges[i];
          if (
            a.id !== b.id ||
            a.source !== b.source ||
            a.target !== b.target ||
            a.selected !== b.selected ||
            a.data?.path !== b.data?.path ||
            a.data?.route !== b.data?.route ||
            a.data?.junction?.x !== b.data?.junction?.x ||
            a.data?.junction?.y !== b.data?.junction?.y ||
            a.style?.stroke !== b.style?.stroke ||
            a.style?.strokeWidth !== b.style?.strokeWidth ||
            a.style?.strokeDasharray !== b.style?.strokeDasharray ||
            a.style?.opacity !== b.style?.opacity
          )
            return false;
        }
        for (let i = 0; i < households.length; i++) {
          const a = households[i], b = nextHouseholds[i];
          if (
            a.id !== b.id ||
            a.position.x !== b.position.x ||
            a.position.y !== b.position.y ||
            a.width !== b.width ||
            a.height !== b.height ||
            a.data.label !== b.data.label ||
            a.data.reverse !== b.data.reverse
          )
            return false;
        }
        currentNodes = nextNodes;
        currentNodesById = new Map(nextNodes.map((node) => [node.id, node]));
        portraitDirty = true;
        return true;
      },
      interaction(hover: string, focus: string) {
        if (hovered !== hover || focused !== focus) portraitDirty = true;
        hovered = hover;
        focused = focus;
      },
      draw(camera: Viewport, width: number, height: number) {
        if (disposed || width <= 0 || height <= 0) return;
        const dpr = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(2_500_000 / (width * height)),
          maxDrawingSize / Math.max(width, height),
        );
        const pixelWidth = Math.max(1, Math.round(width * dpr)),
          pixelHeight = Math.max(1, Math.round(height * dpr));
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
        }
        gl.viewport(0, 0, pixelWidth, pixelHeight);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        [spriteProgram, lineProgram].forEach((p, i) => {
          gl.useProgram(p);
          gl.uniform3f(
            cameraUniforms[i].camera,
            camera.x,
            camera.y,
            camera.zoom,
          );
          gl.uniform2f(cameraUniforms[i].viewport, width, height);
        });
        gl.useProgram(spriteProgram);
        gl.bindTexture(gl.TEXTURE_2D, fontTexture);
        bind(surfaceBatch, 15, [4, 4, 2, 4, 1]);
        gl.useProgram(lineProgram);
        bind(lineBatch, 12, [4, 2, 2, 4]);
        gl.useProgram(spriteProgram);
        gl.bindTexture(gl.TEXTURE_2D, fontTexture);
        bind(junctionBatch, 15, [4, 4, 2, 4, 1]);
        const view = {
          left: -camera.x / camera.zoom,
          top: -camera.y / camera.zoom,
          right: (width - camera.x) / camera.zoom,
          bottom: (height - camera.y) / camera.zoom,
        };
        const high = portraits!.quality(camera.zoom);
        if (
          !cachedBox ||
          view.left < cachedBox.left ||
          view.right > cachedBox.right ||
          view.top < cachedBox.top ||
          view.bottom > cachedBox.bottom ||
          high !== cachedHigh
        )
          portraitDirty = true;
        if (portraitDirty) {
          portraitDirty = false;
          cachedHigh = high;
          const box = {
            left: view.left - 256 / camera.zoom,
            top: view.top - 256 / camera.zoom,
            right: view.right + 256 / camera.zoom,
            bottom: view.bottom + 256 / camera.zoom,
          };
          cachedBox = box;
          const visible =
            camera.zoom < 0.18
              ? currentNodes
                  .filter(
                    (node) =>
                      node.position.x <= box.right &&
                      node.position.x + (node.width || 220) >= box.left &&
                      node.position.y <= box.bottom &&
                      node.position.y + (node.height || 264) >= box.top,
                  )
                  .map((node) => ({
                    node,
                    left: node.position.x,
                    top: node.position.y,
                  }))
              : index.query(box).map((item) => ({
                  ...item,
                  node: currentNodesById.get(item.node.id)!,
                }));
          const cx = (width / 2 - camera.x) / camera.zoom,
            cy = (height / 2 - camera.y) / camera.zoom;
          visible.sort(
            (a, b) =>
              Math.hypot(a.left - cx, a.top - cy) -
              Math.hypot(b.left - cx, b.top - cy),
          );
          portraits!.request(
            visible.flatMap(({ node }) =>
              node.data.person.photo ? [node.data.person.photo] : [],
            ),
            camera.zoom,
          );
          const batches = new Map<WebGLTexture, number[]>();
          for (const { node } of visible) {
            const tile = node.data.person.photo
              ? portraits!.get(node.data.person.photo)
              : undefined;
            const texture = tile?.texture || fontTexture;
            let data = batches.get(texture);
            if (!data) batches.set(texture, (data = []));
            const sex = resolvedSex(node.data.person);
            const rgb =
              sex === "f"
                ? [0.976, 0.929, 0.875]
                : sex === "m"
                  ? [0.87, 0.937, 0.91]
                  : [0.929, 0.922, 0.87];
            // UV includes the shadow margin; sampling happens only inside the circle.
            const uv = tile?.uv || [0, 0, 0, 0];
            const ratio = 148 / 132,
              margin = 8 / 132;
            data.push(
              node.position.x + ((node.width || 220) - 148) / 2,
              node.position.y - 4,
              148,
              148,
              uv[0] - uv[2] * margin,
              uv[1] - uv[3] * margin,
              uv[2] * ratio,
              uv[3] * ratio,
              0,
              10,
              ...rgb,
              node.data.outsideSpotlight ? 0.3 : node.data.dimmed ? 0.6 : 1,
              (tile ? 1 : 0) |
                (tile?.gray ? 32 : 0) |
                (node.data.person.needsReview ? 2 : 0) |
                (node.selected || node.data.spotlit ? 4 : 0) |
                (node.id === hovered || node.id === focused ? 8 : 0),
            );
          }
          for (const batch of portraitBatches.values()) batch.count = 0;
          for (const [texture, data] of batches) {
            let batch = portraitBatches.get(texture);
            if (!batch) {
              const buffer = gl.createBuffer()!;
              buffers.push(buffer);
              portraitBatches.set(
                texture,
                (batch = { buffer, count: 0, bytes: 0 }),
              );
            }
            const array = new Float32Array(data);
            batch.bytes = array.byteLength;
            batch.count = array.length / 15;
            gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, array, gl.DYNAMIC_DRAW);
          }
        }
        let dynamicBytes = 0;
        portraits!.prepare();
        for (const [texture, batch] of portraitBatches) {
          dynamicBytes += batch.bytes;
          if (!batch.count) continue;
          gl.bindTexture(gl.TEXTURE_2D, texture);
          bind(batch, 15, [4, 4, 2, 4, 1]);
        }
        gl.bindTexture(gl.TEXTURE_2D, fontTexture);
        bind(labelBatch, 15, [4, 4, 2, 4, 1]);
        if (!draws && gl.getError() !== gl.NO_ERROR) {
          failure();
          return;
        }
        canvas.dataset.gpuTextureBytes = String(
          portraits!.bytes + Math.ceil((FONT_SIZE * FONT_SIZE * 4 * 4) / 3),
        );
        canvas.dataset.gpuBufferBytes = String(bufferBytes + dynamicBytes);
        canvas.dataset.gpuDraws = String(++draws);
        canvas.dataset.sceneNodes = String(nodes.length);
        canvas.dataset.sceneEdges = String(edges.length);
      },
      destroy,
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
