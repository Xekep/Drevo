import type { Viewport } from "@xyflow/react";
import { fullName, years, resolvedSex } from "../../domain/index.ts";
import { roundedRoute, Spatial, type Box } from "../../domain/edge-routing.ts";
import type { PersonNodeType } from "./person-node";
import type { RelationshipEdgeType } from "./relationship-edge";
import type { HouseholdNodeType } from "./household-node";
import { GpuPortraitCache } from "./gpu-portrait-cache.ts";
import { gpuRoute } from "./gpu-route.ts";
import { layoutGpuText } from "./gpu-text-layout.ts";
import { scheduleGpuLabelPreparation } from "./gpu-label-preparation.ts";
import { createGpuFont, gpuFontAtlasSize as FONT_SIZE, gpuFontSize } from "./gpu-font.ts";
import { gpuPlaceholderCanvas, gpuPlaceholderUv, placeholderWidth, placeholderHeight } from "./gpu-placeholders.ts";

const MAX_BUFFERS = 24 * 1024 * 1024;
type Batch = { buffer: WebGLBuffer; count: number };
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
  retainedPhotos?: ReadonlySet<string>,
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
  let labelArrays: Float32Array[] = [];
  let relationArrays: Float32Array[] = [];
  let cancelRelations = () => {};
  let releaseFont = () => {};
  let portraits: GpuPortraitCache | undefined,
    bufferBytes = 0,
    disposed = false;
  const destroy = (preservePortraits = false) => {
    if (disposed) return;
    disposed = true;
    cancelRelations();
    releaseFont();
    if (!preservePortraits) portraits?.destroy();
    labelArrays.length = 0;
    relationArrays.length = 0;
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
      uniform float sceneOpacity;
      out vec2 texCoord; out vec2 local; out vec4 tint; flat out int mode; flat out vec2 dimensions; flat out vec4 atlasRect;
      void main() { vec2 c=corners[gl_VertexID]; gl_Position=project(rect.xy+c*rect.zw);
        if(camera.z<range.x || camera.z>=range.y) gl_Position=vec4(2,2,0,1);
        texCoord=uv.xy+c*uv.zw; local=c; tint=color; tint.a*=sceneOpacity; mode=int(kind); dimensions=rect.zw; atlasRect=uv; }`,
      `#version 300 es
      precision highp float; precision highp int;
      in vec2 texCoord; in vec2 local; in vec4 tint; flat in int mode; flat in vec2 dimensions; flat in vec4 atlasRect;
      uniform sampler2D atlas; out vec4 outputColor;
      float glyphCoverage(vec2 uv, float aa) {
        // At the smallest zoom a subpixel sample can leave its glyph's tile.
        if(any(lessThan(uv,atlasRect.xy)) || any(greaterThan(uv,atlasRect.xy+atlasRect.zw))) return 0.;
        float value=texture(atlas,uv).r;
        return value==0. ? 0. : clamp((value-.75)/aa+.5,0.,1.);
      }
      void main() {
        if(mode==128) { float r=length((local-.5)*2.); outputColor=vec4(tint.rgb,(1.-smoothstep(0.,1.,r))*tint.a); return; }
        if(mode==129) { vec2 q=abs((local-.5)*dimensions)-dimensions*.5+14.;
          float d=length(max(q,vec2(0)))+min(max(q.x,q.y),0.)-14.; float aa=max(fwidth(d),.4);
          float border=smoothstep(-1.5-aa,-1.5+aa,d); outputColor=vec4(tint.rgb,
            mix(.035,.55,border)*(1.-smoothstep(-aa,aa,d))); return; }
        if(mode==0) {
          vec2 dx=dFdx(texCoord), dy=dFdy(texCoord);
          float aa=max(max(length(dx),length(dy))*${FONT_SIZE / 8}.,.001);
          float coverage=0.;
          // A five-pixel name has strokes smaller than one screen pixel. Integrate
          // their coverage instead of dropping a stroke between sample centers.
          if(aa>.35) {
            for(int y=0;y<4;y++) for(int x=0;x<4;x++)
              coverage+=glyphCoverage(texCoord+dx*(float(x)*.25-.375)+dy*(float(y)*.25-.375),aa*.25)/16.;
          } else coverage=glyphCoverage(texCoord,aa);
          outputColor=vec4(tint.rgb,coverage*tint.a); return;
        }
        if(mode==64) { float r=length(local-.5)*2.; outputColor=vec4(tint.rgb,(1.-smoothstep(.85,1.,r))*tint.a); return; }
        // The quad includes eight world pixels of shadow around the 132px circle.
        float d=length((local-.5)*148.); float aa=max(fwidth(d),.35);
        vec4 result=vec4(.16,.24,.20,exp(-pow(max(d-65.,0.)/4.,2.))*.16*tint.a);
        if(d<=66.+aa) {
          vec2 photoUv=texCoord;
          vec3 base;
          if((mode&1)!=0) { vec3 rgb=texture(atlas,photoUv).rgb; base=vec3((mode&32)!=0 ? rgb.r : dot(rgb,vec3(.2126,.7152,.0722))); }
          else { base=texture(atlas,photoUv).rgb; }
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
      uniform float sceneOpacity;
      out float along; out vec4 tint; flat out vec2 pattern;
      void main() { vec2 c=corners[gl_VertexID], delta=ends.zw-ends.xy;
        float len=length(delta); vec2 normal=vec2(-delta.y,delta.x)/max(len,.001);
        vec2 point=mix(ends.xy,ends.zw,c.x)+normal*(c.y-.5)*max(stroke.x,.4/camera.z);
        gl_Position=project(point); along=stroke.y+c.x*len; tint=color; tint.a*=sceneOpacity; pattern=dash; }`,
      `#version 300 es
      precision highp float;
      in float along; in vec4 tint; flat in vec2 pattern; out vec4 outputColor;
      void main() { if(pattern.y>0. && mod(along,pattern.x+pattern.y)>pattern.x) discard;
        outputColor=tint; }`,
    );
    const cameraUniforms = [spriteProgram, lineProgram].map((p) => ({
      camera: gl.getUniformLocation(p, "camera"),
      viewport: gl.getUniformLocation(p, "viewport"),
      opacity: gl.getUniformLocation(p, "sceneOpacity"),
    }));
    const makeBuffer = (
      data: number[] | Float32Array,
      stride: number,
      name: string,
    ): Batch => {
      const array = data instanceof Float32Array ? data : new Float32Array(data);
      const nextBytes = bufferBytes + array.byteLength;
      if (nextBytes > MAX_BUFFERS)
        throw new Error(
          `GPU geometry budget exceeded: ${name} (${array.byteLength} bytes; total ${nextBytes})`,
        );
      bufferBytes = nextBytes;
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
    const edgeData = (items: readonly RelationshipEdgeType[]) => {
      const lines: number[] = [],
        junctions: number[] = [];
      for (const edge of items) {
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
      return { lines, junctions };
    };
    let currentEdges = edges;
    const initialEdges = edgeData(edges);
    const lineBatch = makeBuffer(initialEdges.lines, 12, "lines"),
      junctionBatch = makeBuffer(initialEdges.junctions, 15, "junctions");
    initialEdges.lines.length = initialEdges.junctions.length = 0;
    const replaceBuffer = (batch: Batch, data: number[], stride: number) => {
      const array = new Float32Array(data);
      const nextBytes = bufferBytes - batch.count * stride * 4 + array.byteLength;
      if (nextBytes > MAX_BUFFERS) throw new Error("GPU geometry budget exceeded");
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
      batch.count = array.length / stride;
      bufferBytes = nextBytes;
    };
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
    const surfaceBatch = makeBuffer(surfaces, 15, "surfaces");
    surfaces.length = 0;
    let font: ReturnType<typeof createGpuFont> | undefined = createGpuFont();
    releaseFont = () => { font = undefined; };
    const glyph = (letter: string, bold: boolean) => font!.glyph(letter, bold);
    const labels: number[][] = [[], [], []];
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
      targetLabels = labels,
    ) => {
      if (!value) return 0;
      // Preserve each layout exactly, retaining only its typed CPU data after
      // construction. Household captions belong to all three zoom ranges.
      const targets = low === 0 && high === 10
        ? targetLabels
        : [targetLabels[low === 0 ? 0 : low === 0.18 ? 1 : 2]];
      // Separate glyphs cannot shape joining scripts or combining sequences.
      // Use the native text renderer for these archives instead of corrupting names.
      if (/[\u0300-\u036f\u0590-\u0fff\u200d]/u.test(value))
        throw new Error("Native text shaping required");
      const maxWidth = (node.width || 220) - 16,
        scale = size / gpuFontSize;
      const rows = layoutGpuText(
        value,
        maxWidth,
        maxLines,
        (letter) => glyph(letter, bold).advance * scale,
      );
      for (const [index, line] of rows.entries()) {
        let x =
          node.position.x +
          (alignRight
            ? (node.width || 220) - 14 - line.width
            : ((node.width || 220) - line.width) / 2);
        for (const letter of line.value) {
          const g = glyph(letter, bold);
          for (const target of targets)
            target.push(
              x + g.left * scale,
              node.position.y + top + index * lineHeight +
                (lineHeight - (g.ascent + g.descent) * scale) / 2 + (g.ascent - g.top) * scale,
              g.width * scale,
              g.height * scale,
              g.x / FONT_SIZE,
              g.y / FONT_SIZE,
              g.width / FONT_SIZE,
              g.height / FONT_SIZE,
              low,
              high,
              ...(bold ? [40 / 255, 60 / 255, 54 / 255] : [104 / 255, 118 / 255, 111 / 255]),
              node.data.outsideSpotlight ? 0.3 : node.data.dimmed ? 0.6 : 1,
              0,
            );
          x += g.advance * scale;
        }
      }
      return Math.min(rows.length, maxLines);
    };
    const nodeLabels = new Map<string, readonly string[]>();
    const relationTops = new Map<string, readonly [number, number]>();
    for (const node of nodes) {
      const name = fullName(node.data.person),
        dates = years(node.data.person);
      nodeLabels.set(node.id, [name, dates]);
      text(name, node, 146, 22, 24, 2, true, 0, 0.18);
      const overviewLines = text(name, node, 146, 22, 24, 2, true, 0.18, 0.52);
      const overviewDates = 146 + overviewLines * 24 + 4;
      text(dates, node, overviewDates, 20, 24, 1, false, 0.18, 0.52);
      const fullLines = text(name, node, 146, 22, 24, 2, true, 0.52, 10);
      const fullDates = 146 + fullLines * 24 + 4;
      text(dates, node, fullDates, 20, 24, 1, false, 0.52, 10);
      relationTops.set(node.id, [overviewDates + (dates ? 28 : 0), fullDates + (dates ? 28 : 0)]);
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
    labelArrays = labels.map((data) => {
      const array = new Float32Array(data);
      data.length = 0;
      return array;
    });
    const labelCpuBytes = labelArrays.reduce((sum, array) => sum + array.byteLength, 0);
    // The first draw chooses the actual camera LOD. Only that LOD occupies
    // the base and relation buffers, including when crossing zoom thresholds.
    const labelBatch = makeBuffer(new Float32Array(0), 15, "labels");
    const relationBatch = makeBuffer(new Float32Array(0), 15, "relations");
    let labelLod = -1,
      labelBytes = 0;
    let relationLod = -1, relationBytes = 0, relationCpuBytes = 0;
    relationArrays = [new Float32Array(0), new Float32Array(0), new Float32Array(0)];
    const fontTexture = gl.createTexture()!;
    textures.push(fontTexture);
    gl.bindTexture(gl.TEXTURE_2D, fontTexture);
    const uploadFont = () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FONT_SIZE, FONT_SIZE,
      0, gl.RED, gl.UNSIGNED_BYTE, font!.data);
    uploadFont();
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let uploadedGlyphs = font.count;
    const placeholderTexture = gl.createTexture()!;
    textures.push(placeholderTexture);
    gl.bindTexture(gl.TEXTURE_2D, placeholderTexture);
    const placeholderCanvas = gpuPlaceholderCanvas();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, placeholderCanvas);
    placeholderCanvas.width = placeholderCanvas.height = 1;
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let portraitDirty = true;
    const photoDraw = () => {
      portraitDirty = true;
      redraw();
    };
    portraits =
      previousPortraits || new GpuPortraitCache(gl, photoDraw, failure);
    const scenePhotos = (items: readonly PersonNodeType[]) => new Set([
      ...(retainedPhotos || []),
      ...items.flatMap(node => node.data.person.photo ? [node.data.person.photo] : []),
    ]);
    portraits.update(
      photoDraw,
      failure,
      scenePhotos(nodes),
    );
    const index = new Spatial<IndexedNode>();
    let currentNodes = nodes;
    let currentRelationLabel = relationLabel;
    const prepareRelations = () => {
      cancelRelations();
      // Drop the previous reference immediately, including its GPU allocation.
      relationArrays = [new Float32Array(0), new Float32Array(0), new Float32Array(0)];
      relationCpuBytes = 0;
      relationLod = -1;
      gl.bindBuffer(gl.ARRAY_BUFFER, relationBatch.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      bufferBytes -= relationBytes;
      relationBytes = relationBatch.count = 0;
      const pending: number[][] = [[], [], []];
      const snapshot = currentNodes, readLabel = currentRelationLabel;
      canvas.dataset.gpuRelationsReady = "false";
      cancelRelations = scheduleGpuLabelPreparation(snapshot.length, (index) => {
        const node = snapshot[index], value = readLabel(node);
        const [overview, full] = relationTops.get(node.id)!;
        text(value, node, overview, 14, 16, 1, false, 0.18, 0.52, false, pending);
        text(value, node, full, 14, 16, 2, false, 0.52, 10, false, pending);
      }, () => {
        relationArrays = pending.map(data => {
          const array = new Float32Array(data);
          data.length = 0;
          return array;
        });
        relationCpuBytes = relationArrays.reduce((sum, array) => sum + array.byteLength, 0);
        // New glyphs share the fixed atlas. No programs, routes or portraits
        // are rebuilt when the asynchronously prepared labels become ready.
        if (font!.count !== uploadedGlyphs) {
          gl.bindTexture(gl.TEXTURE_2D, fontTexture);
          uploadFont();
          uploadedGlyphs = font!.count;
        }
        relationLod = -1;
        canvas.dataset.gpuRelationsReady = "true";
        redraw();
      }, failure);
    };
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
    // The canvas is composited as premultiplied RGBA. RGB needs source alpha,
    // but multiplying alpha by itself makes glyphs and soft edges wash out.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
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
      cachedHigh = false, cachedCompact = false;
    const portraitBatches = new Map<WebGLTexture, Batch & { bytes: number }>();
    return {
      portraits,
      releaseTransitionPhotos() {
        retainedPhotos = undefined;
        portraits!.update(photoDraw, failure, scenePhotos(currentNodes));
      },
      ready: () => portraits!.ready(),
      // A selection changes the portrait ring only. Keep the programs, font
      // atlas and routed geometry if all their inputs remain unchanged.
      update(
        nextNodes: readonly PersonNodeType[],
        nextEdges: readonly RelationshipEdgeType[],
        nextHouseholds: readonly HouseholdNodeType[],
        nextRelationLabel: (node: PersonNodeType) => string,
      ) {
        const changed = (reason: string) => {
          canvas.dataset.gpuUpdateReason = reason;
          return false;
        };
        if (
          disposed ||
          currentNodes.length !== nextNodes.length ||
          currentEdges.length !== nextEdges.length ||
          households.length !== nextHouseholds.length
        )
          return changed("membership");
        for (let i = 0; i < currentNodes.length; i++) {
          const a = currentNodes[i], b = nextNodes[i];
          const labels = nodeLabels.get(a.id)!;
          if (
            a.id !== b.id ||
            a.position.x !== b.position.x ||
            a.position.y !== b.position.y ||
            a.width !== b.width ||
            a.height !== b.height ||
            // Detail hydration replaces Person objects without changing the
            // rendered text. Compare the immutable label values, not identities.
            labels[0] !== fullName(b.data.person) ||
            labels[1] !== years(b.data.person) ||
            a.data.dimmed !== b.data.dimmed ||
            a.data.outsideSpotlight !== b.data.outsideSpotlight
          )
            return changed("node");
        }
        let edgesChanged = false;
        for (let i = 0; i < currentEdges.length; i++) {
          const a = currentEdges[i], b = nextEdges[i];
          if (
            a.id !== b.id ||
            a.source !== b.source ||
            a.target !== b.target ||
            a.selected !== b.selected ||
            (a.data?.path || (a.data?.route && roundedRoute(a.data.route.points).path)) !==
              (b.data?.path || (b.data?.route && roundedRoute(b.data.route.points).path)) ||
            a.data?.junction?.x !== b.data?.junction?.x ||
            a.data?.junction?.y !== b.data?.junction?.y ||
            a.style?.stroke !== b.style?.stroke ||
            a.style?.strokeWidth !== b.style?.strokeWidth ||
            a.style?.strokeDasharray !== b.style?.strokeDasharray ||
            a.style?.opacity !== b.style?.opacity
          )
            edgesChanged = true;
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
            return changed("household");
        }
        currentNodes = nextNodes;
        if (edgesChanged) {
          // Crossing gaps change with screen scale. Updating their line data
          // must not rebuild fonts/programs or restart a scene transition.
          const next = edgeData(nextEdges);
          replaceBuffer(lineBatch, next.lines, 12);
          replaceBuffer(junctionBatch, next.junctions, 15);
          currentEdges = nextEdges;
        }
        if (currentRelationLabel !== nextRelationLabel) {
          currentRelationLabel = nextRelationLabel;
          // Before the first draw there is no work to cancel or start yet.
          if (draws) prepareRelations();
        }
        currentNodesById = new Map(nextNodes.map((node) => [node.id, node]));
        portraits!.update(photoDraw, failure, scenePhotos(nextNodes));
        portraitDirty = true;
        return true;
      },
      interaction(hover: string, focus: string) {
        if (hovered !== hover || focused !== focus) portraitDirty = true;
        hovered = hover;
        focused = focus;
      },
      draw(camera: Viewport, width: number, height: number,
        options: { opacity?: number; clear?: boolean } = {}) {
        if (disposed || width <= 0 || height <= 0) return;
        const dpr = Math.min(
          window.devicePixelRatio || 1,
          2,
          // Keep QHD at native resolution; smaller targets soften tiny labels
          // even at DPR 1. Higher-DPI/4K screens still have a bounded buffer.
          Math.sqrt(4_000_000 / (width * height)),
          maxDrawingSize / Math.max(width, height),
        );
        const pixelWidth = Math.max(1, Math.round(width * dpr)),
          pixelHeight = Math.max(1, Math.round(height * dpr));
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
        }
        // Resize the displayed bitmap together with its projection. A 100%
        // canvas stretches the previous frame while React Flow's observer
        // catches up with an inspector opening/closing, even at a fixed camera.
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        gl.viewport(0, 0, pixelWidth, pixelHeight);
        gl.clearColor(0, 0, 0, 0);
        if (options.clear !== false) gl.clear(gl.COLOR_BUFFER_BIT);
        [spriteProgram, lineProgram].forEach((p, i) => {
          gl.useProgram(p);
          gl.uniform1f(cameraUniforms[i].opacity, options.opacity ?? 1);
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
          high !== cachedHigh || cachedCompact !== (camera.zoom < 0.18)
        )
          portraitDirty = true;
        if (portraitDirty) {
          portraitDirty = false;
          cachedHigh = high;
          cachedCompact = camera.zoom < 0.18;
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
          let visiblePhotos = 0, texturedPhotos = 0;
          for (const { node } of visible) {
            const tile = node.data.person.photo
              ? portraits!.get(node.data.person.photo)
              : undefined;
            if (node.data.person.photo) {
              visiblePhotos++;
              if (tile) texturedPhotos++;
            }
            const texture = tile?.texture || placeholderTexture;
            let data = batches.get(texture);
            if (!data) batches.set(texture, (data = []));
            const sex = resolvedSex(node.data.person);
            // UV includes the shadow margin; sampling happens only inside the circle.
            const uv = tile?.uv || gpuPlaceholderUv(sex, cachedCompact);
            const diameter = tile ? 132 : 126;
            const ratio = 148 / diameter,
              margin = (148 - diameter) / 2 / diameter;
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
              1, 1, 1,
              node.data.outsideSpotlight ? 0.3 : node.data.dimmed ? 0.6 : 1,
              // Glyphs use kind 0. Keep even an ordinary photo-less portrait
              // in its own range; review/selection must not decide its type.
              16 | (tile ? 1 : 0) |
                (tile?.gray ? 32 : 0) |
                (node.data.person.needsReview ? 2 : 0) |
                (node.selected || node.data.spotlit ? 4 : 0) |
                (node.id === hovered || node.id === focused ? 8 : 0),
            );
          }
          canvas.dataset.gpuVisiblePhotos = String(visiblePhotos);
          canvas.dataset.gpuTexturedPhotos = String(texturedPhotos);
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
        const nextLabelLod = camera.zoom < 0.18 ? 0 : camera.zoom < 0.52 ? 1 : 2;
        if (nextLabelLod !== labelLod || nextLabelLod !== relationLod) {
          const array = labelArrays[nextLabelLod];
          const relations = relationArrays[nextLabelLod];
          const nextBytes = bufferBytes - labelBytes - relationBytes + array.byteLength + relations.byteLength;
          if (nextBytes > MAX_BUFFERS)
            throw new Error(
              `GPU geometry budget exceeded: labels LOD ${nextLabelLod} (${array.byteLength} bytes; total ${nextBytes})`,
            );
          gl.bindBuffer(gl.ARRAY_BUFFER, labelBatch.buffer);
          gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
          labelBatch.count = array.length / 15;
          gl.bindBuffer(gl.ARRAY_BUFFER, relationBatch.buffer);
          gl.bufferData(gl.ARRAY_BUFFER, relations, gl.STATIC_DRAW);
          relationBatch.count = relations.length / 15;
          bufferBytes = nextBytes;
          labelBytes = array.byteLength;
          relationBytes = relations.byteLength;
          labelLod = nextLabelLod;
          relationLod = nextLabelLod;
          canvas.dataset.gpuLabelLod = String(labelLod);
        }
        bind(labelBatch, 15, [4, 4, 2, 4, 1]);
        bind(relationBatch, 15, [4, 4, 2, 4, 1]);
        canvas.dataset.gpuLabelBytes = String(labelBytes + relationBytes);
        canvas.dataset.gpuLabelCpuBytes = String(labelCpuBytes + relationCpuBytes);
        if (!draws && gl.getError() !== gl.NO_ERROR) {
          failure();
          return;
        }
        canvas.dataset.gpuTextureBytes = String(
          portraits!.bytes + FONT_SIZE ** 2 + Math.ceil(placeholderWidth * placeholderHeight * 4 * 4 / 3),
        );
        canvas.dataset.gpuBufferBytes = String(bufferBytes + dynamicBytes);
        canvas.dataset.gpuDraws = String(++draws);
        canvas.dataset.sceneNodes = String(nodes.length);
        canvas.dataset.sceneEdges = String(currentEdges.length);
        if (draws === 1) prepareRelations();
      },
      destroy,
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
