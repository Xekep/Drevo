import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Person } from "../../domain";
import {
  spatialCardFloor,
  spatialCardLimit,
  type SpatialWorld,
} from "../../domain/tree-spatial";
import type { TreeFitOptions } from "./tree-camera-fit";
import { SpatialCardAtlas, type SpatialPalette } from "./spatial-card-atlas";
import { SpatialNameAtlas } from "./spatial-name-atlas";
import { SpatialLabelMask } from "./spatial-label-mask";
import { placeSpatialCards, type CardOffset } from "../../domain/spatial-card-layout.ts";
import { SpatialCardProjection, spatialLayoutDeclarations } from "./spatial-card-projection.ts";
import { SpatialArrowMotion } from "./spatial-arrow-motion";
import { SpatialSpinGesture, type SpinDirection } from "./spatial-spin-gesture";
import {
  edgeEndpointClip,
  edgeEndpointFragmentDeclarations,
  edgeEndpointVertex,
  edgeEndpointVertexDeclarations,
  setSpatialEdgeEndpoints,
} from "./spatial-edge-occlusion.ts";

type Callbacks = {
  profile: (id: string) => void;
  choose: (id: string) => void;
  select: (id: string) => void;
  failure: () => void;
};
type ProjectedPerson = {
  id: string;
  x: number;
  y: number;
  size: number;
  distance: number;
  z: number;
};
const labelDeclarations = "uniform sampler2D labelMask; uniform vec2 viewport;";
const labelClip =
  `vec4 label=texture2D(labelMask,gl_FragCoord.xy/viewport);
float labelDepth=dot(floor(label.rgb*255.+.5),vec3(65536.,256.,1.))/16777215.;
if(label.a>.95&&gl_FragCoord.z>=labelDepth-0.0000001)discard;`;
const cardVertex = `attribute vec3 center; attribute vec4 tile; attribute vec4 offset; attribute float date;
attribute float layoutIndex; uniform float focal;
${spatialLayoutDeclarations}
uniform vec3 hoverCenter; uniform float hoverEnabled;
varying vec2 vUv; varying vec2 vLocal; varying float vAlpha; varying float vHover;
void main(){vUv=tile.xy+uv*tile.zw;vLocal=uv;
vHover=hoverEnabled*(1.-step(.1,distance(center,hoverCenter)));
vec4 p=viewMatrix*vec4(center,1.);
vec3 cardData=readCardLayout(layoutIndex);float pixels=cardData.z;
vAlpha=mix(1.,smoothstep(110.,140.,pixels),date);
p.xy+=(vec2(cardData.x,-cardData.y)+(offset.xy+position.xy*offset.zw)*pixels)*max(1.,-p.z)/focal;
gl_Position=p.z>=-1.?vec4(2.,2.,2.,1.):projectionMatrix*p;}`;
const cardFragment = `uniform sampler2D atlas; uniform vec3 hoverColor; uniform float portrait;
varying vec2 vUv; varying vec2 vLocal; varying float vAlpha; varying float vHover;
void main(){vec4 c=texture2D(atlas,vUv);
float r=distance(vLocal,vec2(.5));
float ring=smoothstep(.435,.45,r)*(1.-smoothstep(.48,.495,r))*vHover*portrait;
c.rgb=mix(c.rgb,hoverColor,ring);c.a=max(c.a,ring);
c.a*=vAlpha;if(c.a<.1)discard;gl_FragColor=c;
#include <colorspace_fragment>
}`;

/** Owns the WebGL context, controls, demand-only projection and GPU/image resources.
 * React never receives camera frames. Geometry uploads once per topology change.
 */
export class SpatialRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(42, 1, 1, 1_000_000);
  readonly controls: OrbitControls;
  private scene = new THREE.Scene();
  private atlas: SpatialCardAtlas;
  private cards: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  private names: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  private nameAtlas: SpatialNameAtlas;
  private labelMask = new SpatialLabelMask();
  private viewport = { value: new THREE.Vector2(1, 1) };
  private labelViewport = { value: new THREE.Vector2(1, 1) };
  private cardProjection: SpatialCardProjection;
  private cardOffsets = new Map<string, CardOffset>();
  private leaders: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private hoverCenter = { value: new THREE.Vector3() };
  private hoverEnabled = { value: 0 };
  private hovered: string | null = null;
  private labelPeople: ReadonlyMap<string, Person> | null = null;
  private edges: THREE.LineSegments<
    THREE.BufferGeometry,
    THREE.LineBasicMaterial
  >;
  private arrows: SpatialArrowMotion;
  private frame = 0;
  private stopped = false;
  private hidden = document.hidden;
  private contextLost = false;
  private observer: ResizeObserver;
  private width = 1;
  private height = 1;
  private projected: ProjectedPerson[] = [];
  private anchor = "";
  private details = new Set<string>();
  private fly: {
    start: number;
    duration: number;
    from: THREE.Vector3;
    to: THREE.Vector3;
    targetFrom: THREE.Vector3;
    targetTo: THREE.Vector3;
  } | null = null;
  private pointer: {
    id: number;
    x: number;
    y: number;
    hit?: string;
    long: boolean;
  } | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  private spinGesture = new SpatialSpinGesture();
  private spinTimer: ReturnType<typeof setTimeout> | undefined;
  private spinTime = 0;
  private spinDirection: SpinDirection = 1;
  private spinActive = false;
  private spinZoom: { from: number; to: number; start: number } | null = null;
  private touchPointers = new Set<number>();
  private pinchCandidate: { direction: SpinDirection; time: number; x: number; y: number } | null = null;
  private pinchZoom = false;
  private strokeClick: { x: number; y: number; time: number } | null = null;
  private updatingSpin = false;
  private dampingActive = false;
  private dampingTime = 0;
  private dampingUntil = 0;
  private controlsInteracting = false;
  private ids: string[];
  constructor(
    private host: HTMLDivElement,
    private world: SpatialWorld,
    private people: ReadonlyMap<string, Person>,
    private palette: SpatialPalette,
    private callbacks: Callbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    const canvas = this.renderer.domElement;
    canvas.className = "tree-spatial-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "3D-древо. Перетаскивание — поворот с плавной остановкой. Стрелки — поворот, Shift и стрелки — сдвиг, плюс и минус — масштаб, Home — всё древо. Быстрый горизонтальный жест включает медленное вращение. Масштабирование сохраняет вращение; остальные нажатия останавливают его. Пробел — включить или остановить вращение. Люди доступны в списке рядом.",
    );
    host.prepend(canvas);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = !this.reduced.matches;
    this.controls.dampingFactor = 0.14;
    this.controls.minDistance = 260;
    this.controls.maxDistance = 200_000;
    this.controls.maxPolarAngle = Math.PI - 0.06;
    this.controls.minPolarAngle = 0.06;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.addEventListener("change", this.controlsChanged);
    this.controls.addEventListener("start", this.controlsStarted);
    this.controls.addEventListener("end", this.controlsEnded);
    host.dataset.depthSpinning = "false";
    this.ids = [...world.points.keys()];
    this.cardProjection = new SpatialCardProjection(this.ids);
    const linePositions: number[] = [];
    for (const edge of world.connections) {
      const a = world.points.get(edge.from)!,
        b = world.points.get(edge.to)!;
      linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const lineGeometry = new THREE.BufferGeometry();
    setSpatialEdgeEndpoints(lineGeometry, world, world.connections);
    lineGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(linePositions, 3),
    );
    lineGeometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        new Float32Array(linePositions.length),
        3,
      ),
    );
    this.edges = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.65,
      }),
    );
    this.maskUnderLabels(this.edges.material);
    // Fill portraits/names first: transparent foreground lines must blend with
    // the real distant surface, rather than the clear canvas colour.
    this.edges.renderOrder = 3;
    this.scene.add(this.edges);
    const leaderGeometry = new THREE.BufferGeometry();
    leaderGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.ids.length * 6), 3)
      .setUsage(THREE.DynamicDrawUsage));
    leaderGeometry.setDrawRange(0, 0);
    this.leaders = new THREE.LineSegments(leaderGeometry, new THREE.LineBasicMaterial({
      color: palette.muted, transparent: true, opacity: .35,
    }));
    this.leaders.frustumCulled = false;
    this.leaders.renderOrder = 3;
    this.maskUnderLabels(this.leaders.material, false);
    this.scene.add(this.leaders);
    this.arrows = new SpatialArrowMotion(world, palette.green, this.drawArrowFrame,
      () => !this.stopped && !this.hidden && !this.contextLost && !this.host.closest("[inert]"));
    this.maskUnderLabels(this.arrows.mesh.material);
    this.arrows.mesh.renderOrder = 3;
    this.scene.add(this.arrows.mesh);
    this.atlas = new SpatialCardAtlas(
      palette,
      this.invalidate,
      this.ids.length,
    );
    this.nameAtlas = new SpatialNameAtlas(palette);
    const cardGeometry = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    cardGeometry.index = plane.index;
    cardGeometry.attributes = plane.attributes;
    cardGeometry.setAttribute(
      "center",
      new THREE.InstancedBufferAttribute(
        new Float32Array(this.atlas.capacity * 3),
        3,
      ),
    );
    cardGeometry.setAttribute(
      "tile",
      new THREE.InstancedBufferAttribute(
        new Float32Array(this.atlas.capacity * 4),
        4,
      ),
    );
    cardGeometry.setAttribute(
      "offset",
      new THREE.InstancedBufferAttribute(
        new Float32Array(this.atlas.capacity * 4),
        4,
      ),
    );
    cardGeometry.setAttribute(
      "date",
      new THREE.InstancedBufferAttribute(
        new Float32Array(this.atlas.capacity),
        1,
      ),
    );
    cardGeometry.setAttribute("layoutIndex", new THREE.InstancedBufferAttribute(new Float32Array(this.atlas.capacity), 1));
    cardGeometry.instanceCount = 0;
    const material = (texture: THREE.Texture, portrait = 0) =>
      new THREE.ShaderMaterial({
        uniforms: {
          atlas: { value: texture },
          focal: { value: 1 },
          cardLayout: { value: this.cardProjection.texture },
          cardLayoutSize: { value: this.cardProjection.dimensions },
          hoverCenter: this.hoverCenter,
          hoverEnabled: this.hoverEnabled,
          hoverColor: { value: new THREE.Color(palette.green) },
          portrait: { value: portrait },
        },
        vertexShader: cardVertex,
        fragmentShader: cardFragment,
        transparent: true,
        // Instances share one draw call, so object-level transparent sorting
        // cannot order people. Discarded texels leave holes; visible texels
        // must participate in the same depth buffer for portraits AND names.
        depthWrite: true,
        depthTest: true,
        side: THREE.DoubleSide,
      });
    this.cards = new THREE.Mesh(cardGeometry, material(this.atlas.texture, 1));
    this.cards.frustumCulled = false;
    this.cards.renderOrder = 1;
    this.scene.add(this.cards);
    const nameGeometry = new THREE.InstancedBufferGeometry();
    nameGeometry.index = plane.index;
    nameGeometry.attributes = {
      position: plane.attributes.position.clone(),
      uv: plane.attributes.uv.clone(),
      normal: plane.attributes.normal.clone(),
    };
    nameGeometry.instanceCount = 0;
    this.names = new THREE.Mesh(nameGeometry, material(this.nameAtlas.texture));
    this.names.frustumCulled = false;
    this.names.renderOrder = 2;
    this.scene.add(this.names);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(host);
    document.addEventListener("visibilitychange", this.visibility);
    this.reduced.addEventListener("change", this.motionPreference);
    document.addEventListener("pointerdown", this.documentPress, true);
    document.addEventListener("click", this.documentClick, true);
    document.addEventListener("keydown", this.documentKey, true);
    window.addEventListener("blur", this.cancelSpin);
    canvas.addEventListener("webglcontextlost", this.lost);
    canvas.addEventListener("webglcontextrestored", this.restored);
    canvas.addEventListener("pointerdown", this.pointerDown);
    canvas.addEventListener("pointermove", this.pointerMove);
    canvas.addEventListener("pointerup", this.pointerUp);
    canvas.addEventListener("pointercancel", this.pointerCancel);
    canvas.addEventListener("pointerleave", this.pointerLeave);
    canvas.addEventListener("keydown", this.keyDown);
    this.resize();
    this.update(people, "", new Set(), callbacks);
  }
  update(
    people: ReadonlyMap<string, Person>,
    anchor: string,
    active: ReadonlySet<string>,
    callbacks: Callbacks,
  ) {
    this.people = people;
    this.callbacks = callbacks;
    const lines = this.edges.geometry.getAttribute("color");
    const green = new THREE.Color(this.palette.green),
      muted = new THREE.Color(this.palette.muted),
      red = new THREE.Color(this.palette.red);
    this.world.connections.forEach((edge, i) => {
      const color =
        edge.type === "partner"
          ? red
          : active.has(edge.from) && active.has(edge.to)
            ? green
            : muted;
      lines.setXYZ(i * 2, ...(color.toArray() as [number, number, number]));
      lines.setXYZ(i * 2 + 1, ...(color.toArray() as [number, number, number]));
    });
    lines.needsUpdate = true;
    if (this.labelPeople !== people) {
      this.labelPeople = people;
      const visiblePeople = this.ids
        .map((id) => people.get(id)!)
        .filter(Boolean);
      this.atlas.update(visiblePeople);
      this.nameAtlas.update(visiblePeople);
      const centers: number[] = [],
        tiles: number[] = [],
        layouts: number[] = [],
        dates: number[] = [], indices: number[] = [];
      for (const person of visiblePeople) {
        const point = this.world.points.get(person.id)!;
        for (const glyph of this.nameAtlas.layout(person)) {
          centers.push(point.x, point.y, point.z);
          tiles.push(...glyph.tile);
          layouts.push(...glyph.layout);
          dates.push(glyph.date);
          indices.push(this.cardProjection.indices.get(person.id)!);
        }
      }
      const geometry = this.names.geometry;
      // Release replaced instance buffers on data edits, while keeping the
      // independently owned base plane available for the next upload.
      if (geometry.getAttribute("center")) geometry.dispose();
      geometry.setAttribute(
        "center",
        new THREE.InstancedBufferAttribute(new Float32Array(centers), 3),
      );
      geometry.setAttribute(
        "tile",
        new THREE.InstancedBufferAttribute(new Float32Array(tiles), 4),
      );
      geometry.setAttribute(
        "offset",
        new THREE.InstancedBufferAttribute(new Float32Array(layouts), 4),
      );
      geometry.setAttribute(
        "date",
        new THREE.InstancedBufferAttribute(new Float32Array(dates), 1),
      );
      geometry.setAttribute("layoutIndex", new THREE.InstancedBufferAttribute(new Float32Array(indices), 1));
      geometry.instanceCount = dates.length;
      this.host.dataset.depthNamePeople = String(visiblePeople.length);
    }
    if (anchor && this.anchor !== anchor) {
      const initial = !this.anchor;
      this.anchor = anchor;
      this.focus(anchor, initial ? 0 : 620);
    }
    this.invalidate();
  }
  private resize = () => {
    if (this.stopped) return;
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.cards.material.uniforms.focal.value =
      this.names.material.uniforms.focal.value =
        this.height /
        (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.viewport.value.set(
      this.width * this.renderer.getPixelRatio(),
      this.height * this.renderer.getPixelRatio(),
    );
    this.labelViewport.value.set(this.width, this.height);
    this.invalidate();
  };
  private maskUnderLabels(material: THREE.Material, endpoints = true) {
    const previous = material.onBeforeCompile;
    const programKey = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${programKey()}:spatial-endpoints-${Number(endpoints)}`;
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      shader.uniforms.labelMask = { value: this.labelMask.texture };
      shader.uniforms.viewport = this.viewport;
      shader.uniforms.labelViewport = this.labelViewport;
      shader.uniforms.cardLayout = { value: this.cardProjection.texture };
      shader.uniforms.cardLayoutSize = { value: this.cardProjection.dimensions };
      if (endpoints) shader.vertexShader = `${edgeEndpointVertexDeclarations}\n${shader.vertexShader}`
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${edgeEndpointVertex}`);
      shader.fragmentShader =
        `${labelDeclarations}\n${endpoints ? edgeEndpointFragmentDeclarations : ""}\n${shader.fragmentShader}`.replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>\n${endpoints ? edgeEndpointClip : ""}\n${labelClip}`,
        );
    };
  }
  private visibility = () => {
    this.hidden = document.hidden;
    if (this.hidden) {
      this.cancelSpin();
      this.arrows.stop();
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    } else this.invalidate();
  };
  private lost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.cancelSpin();
    this.arrows.stop();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.callbacks.failure();
  };
  private restored = () => {
    this.contextLost = false;
    this.invalidate();
  };
  private interrupt = () => {
    this.spinZoom = null;
    this.setHover(null);
    this.fly = null;
    this.host.dataset.depthMoving = "false";
  };
  private controlsStarted = () => {
    this.interrupt();
    this.controlsInteracting = true;
    if (!this.spinActive && !this.reduced.matches) {
      this.dampingActive = true;
      this.dampingTime = performance.now();
      this.dampingUntil = Infinity;
    }
    this.host.dataset.depthMoving = String(this.dampingActive);
  };
  private controlsEnded = () => {
    this.controlsInteracting = false;
    this.dampingUntil = performance.now() + 800;
    if (this.dampingActive) this.invalidate();
  };
  private controlsChanged = () => {
    if (!this.updatingSpin) {
      if (this.controlsInteracting && !this.spinActive && !this.reduced.matches) {
        if (!this.dampingActive) this.dampingTime = performance.now();
        this.dampingActive = true;
        this.host.dataset.depthMoving = "true";
      }
      this.invalidate();
    }
  };
  private stopDamping() {
    this.dampingActive = false;
    this.host.dataset.depthMoving = String(!!this.fly);
    // Consume pending OrbitControls deltas through its public API, restoring
    // the visible pose so a click/explicit navigation never causes a last jump.
    const position = this.camera.position.clone();
    const target = this.controls.target.clone();
    const enabled = this.controls.enableDamping;
    const updating = this.updatingSpin;
    this.updatingSpin = true;
    this.controls.enableDamping = false;
    try {
      this.controls.update(0);
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update(0);
    } finally {
      this.controls.enableDamping = enabled;
      this.updatingSpin = updating;
    }
  }
  private stopSpin = () => {
    this.spinActive = false;
    this.spinZoom = null;
    this.controls.autoRotate = false;
    this.stopDamping();
    this.controls.enableDamping = !this.reduced.matches;
    this.spinTime = 0;
    clearTimeout(this.spinTimer);
    this.spinTimer = undefined;
    this.host.dataset.depthSpinning = "false";
  };
  private cancelSpin = () => {
    this.controlsInteracting = false;
    this.spinGesture.cancel();
    this.touchPointers.clear();
    this.pinchCandidate = null;
    this.pinchZoom = false;
    this.strokeClick = null;
    this.stopSpin();
  };
  private isZoomControl(target: EventTarget | null) {
    const control = target instanceof Element ? target.closest("[data-tree-zoom]") : null;
    return !!control && !!this.host.closest(".tree-canvas")?.contains(control);
  }
  private documentPress = (event: PointerEvent) => {
    this.strokeClick = null;
    if (this.isZoomControl(event.target)) return;
    // The second touch identifies a pinch. A single touch still stops the
    // command immediately; only a genuine pinch may restore its prior state.
    if (event.target === this.renderer.domElement && event.pointerType === "touch") return;
    this.pinchCandidate = null;
    this.stopSpin();
    if (event.target !== this.renderer.domElement) this.spinGesture.cancel();
  };
  private documentClick = (event: MouseEvent) => {
    if (this.isZoomControl(event.target)) return;
    const stroke = this.strokeClick;
    this.strokeClick = null;
    if (stroke && event.isTrusted && event.target === this.renderer.domElement &&
        event.timeStamp - stroke.time >= 0 && event.timeStamp - stroke.time < 350 &&
        Math.hypot(event.clientX - stroke.x, event.clientY - stroke.y) < 4) return;
    // A drag can end with a native click on the canvas. The next pointerdown
    // already stops rotation; synthetic/assistive clicks must also stop it.
    if (!event.detail || event.target !== this.renderer.domElement) this.cancelSpin();
  };
  private documentKey = (event: KeyboardEvent) => {
    const canvasKey = event.target === this.renderer.domElement && [" ", "+", "=", "-"].includes(event.key);
    const zoomKey = this.isZoomControl(event.target) && ["Enter", " "].includes(event.key);
    if (!canvasKey && !zoomKey) this.cancelSpin();
  };
  private motionPreference = () => {
    if (this.reduced.matches) this.cancelSpin();
    this.controls.enableDamping = !this.reduced.matches && !this.spinActive;
    this.invalidate();
  };
  private startSpin(direction: SpinDirection) {
    if (!direction || this.reduced.matches || !this.controls.enabled || this.hidden || this.stopped ||
        this.contextLost || this.host.closest("[inert]")) return;
    this.setHover(null);
    this.stopDamping();
    this.controls.enableDamping = false;
    this.fly = null;
    this.host.dataset.depthMoving = "false";
    this.spinDirection = direction;
    this.controls.autoRotateSpeed = direction / 3; // 2 degrees/s; one turn in three minutes.
    this.spinActive = true;
    this.spinTime = performance.now();
    this.host.dataset.depthSpinning = "true";
    this.host.dataset.depthSpinDirection = String(direction);
    this.arrows.stop();
    this.invalidate();
  }
  private clearPress() {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }
  personAt(x: number, y: number) {
    const b = this.renderer.domElement.getBoundingClientRect();
    let nearest: ProjectedPerson | undefined;
    for (const p of this.projected) {
      const full = this.details.has(p.id),
        width = full ? p.size * 0.5 : 13,
        height = full ? p.size * 0.5 : 13;
      if (
        Math.abs(p.x - (x - b.left)) <= width &&
        Math.abs(p.y - (y - b.top)) <= height &&
        (!nearest ||
          Number(full) > Number(this.details.has(nearest.id)) ||
          (full === this.details.has(nearest.id) &&
            p.distance < nearest.distance))
      )
        nearest = p;
    }
    return nearest?.id;
  }
  private setHover(id: string | null) {
    if (this.hovered === id) return;
    this.hovered = id;
    const point = id ? this.world.points.get(id) : undefined;
    this.hoverEnabled.value = point ? 1 : 0;
    if (point) this.hoverCenter.value.set(point.x, point.y, point.z);
    this.host.dataset.depthHovered = id || "";
    this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
    this.invalidate();
  }
  private pointerLeave = () => this.setHover(null);
  private pointerDown = (event: PointerEvent) => {
    this.setHover(null);
    if (event.pointerType === "touch") {
      if (!this.touchPointers.size) {
        const direction = this.spinActive ? this.spinDirection : 0;
        this.stopSpin();
        this.pinchZoom = false;
        this.pinchCandidate = direction ? { direction, time: event.timeStamp, x: event.clientX, y: event.clientY } : null;
      }
      this.touchPointers.add(event.pointerId);
      if (this.touchPointers.size === 2 && this.pinchCandidate) {
        if (event.timeStamp - this.pinchCandidate.time <= 250) {
          this.pinchZoom = true;
          this.startSpin(this.pinchCandidate.direction);
        }
        this.pinchCandidate = null;
      } else if (this.touchPointers.size > 2) this.cancelSpin();
    }
    this.spinGesture.begin(event.pointerId,
      { x: event.clientX, y: event.clientY, time: event.timeStamp }, this.height,
      this.controls.enabled && !this.reduced.matches && event.button === 0 &&
        !event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey);
    const hit = this.personAt(event.clientX, event.clientY);
    if (this.pointer) {
      this.clearPress();
      this.pointer = null;
      return;
    }
    this.pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      hit,
      long: false,
    };
    if (hit && event.pointerType !== "mouse")
      this.pressTimer = setTimeout(() => {
        if (this.pointer) {
          this.pointer.long = true;
          this.callbacks.select(hit);
        }
      }, 500);
  };
  private pointerMove = (event: PointerEvent) => {
    if (this.touchPointers.size === 1 && this.pinchCandidate &&
        Math.hypot(event.clientX - this.pinchCandidate.x, event.clientY - this.pinchCandidate.y) > 12)
      this.pinchCandidate = null;
    if (event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) this.spinGesture.cancel();
    else this.spinGesture.move(event.pointerId, { x: event.clientX, y: event.clientY, time: event.timeStamp });
    if (event.pointerType === "mouse" && !event.buttons)
      this.setHover(this.personAt(event.clientX, event.clientY) || null);
    if (
      this.pointer?.id === event.pointerId &&
      Math.hypot(
        event.clientX - this.pointer.x,
        event.clientY - this.pointer.y,
      ) > 6
    ) {
      this.clearPress();
      this.pointer = null;
    }
  };
  private pointerUp = (event: PointerEvent) => {
    const pinch = this.pinchZoom;
    this.touchPointers.delete(event.pointerId);
    const spin = this.spinGesture.end(event.pointerId,
      { x: event.clientX, y: event.clientY, time: event.timeStamp });
    if (spin && event.button === 0) this.startSpin(spin);
    if ((spin || pinch) && this.spinActive)
      this.strokeClick = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    if (!this.touchPointers.size) {
      this.pinchZoom = false;
      this.pinchCandidate = null;
    }
    const press = this.pointer;
    this.clearPress();
    this.pointer = null;
    if (
      !press ||
      press.id !== event.pointerId ||
      press.long ||
      event.button !== 0 ||
      !press.hit
    )
      return;
    if (event.shiftKey) this.callbacks.select(press.hit);
    else this.callbacks.profile(press.hit);
  };
  private pointerCancel = (event: PointerEvent) => {
    this.spinGesture.cancel(event.pointerId);
    this.cancelSpin();
    this.setHover(null);
    this.clearPress();
    this.pointer = null;
  };
  private keyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    let handled = true;
    if (event.key === " ") {
      if (this.spinActive) this.cancelSpin(); else this.startSpin(this.spinDirection);
    } else if (event.key === "+" || event.key === "=") this.zoom(1);
    else if (event.key === "-") this.zoom(-1);
    else if (event.key === "Home") void this.fit();
    else if (event.key === "Enter" && this.anchor)
      this.callbacks.profile(this.anchor);
    else if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      const x =
        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      const y =
        event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (event.shiftKey) {
        const offset = new THREE.Vector3(x * 90, -y * 90, 0).applyQuaternion(
          this.camera.quaternion,
        );
        this.camera.position.add(offset);
        this.controls.target.add(offset);
        this.interrupt();
        this.controls.update();
      } else this.rotate(x * 0.22, y * 0.18);
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  invalidate = () => {
    if (!this.stopped && !this.hidden && !this.contextLost && !this.frame)
      this.frame = requestAnimationFrame(this.render);
  };
  private render = (time: number) => {
    this.frame = 0;
    clearTimeout(this.spinTimer);
    this.spinTimer = undefined;
    if (this.stopped || this.hidden || this.contextLost) return;
    this.arrows.stop();
    const started = performance.now();
    if (this.spinActive) {
      if (!this.controls.enabled || this.reduced.matches || this.host.closest("[inert]")) this.cancelSpin();
      else {
        const delta = Math.min(.1, Math.max(0, (time - this.spinTime) / 1000));
        this.spinTime = time;
        this.updatingSpin = true;
        this.controls.autoRotate = true;
        try {
          this.controls.update(delta);
          // Native wheel/pinch updates must not add an extra fixed-time orbit.
          this.controls.autoRotate = false;
        } finally {
          this.controls.autoRotate = false;
          this.updatingSpin = false;
        }
      }
    }
    if (this.dampingActive && !this.spinActive && !this.fly) {
      if (!this.controls.enabled || this.reduced.matches || this.host.closest("[inert]") || time >= this.dampingUntil)
        this.stopDamping();
      else {
        const delta = Math.max(1 / 240, Math.min(.05, (time - this.dampingTime) / 1000));
        this.dampingTime = time;
        this.controls.dampingFactor = 1 - Math.exp(-9 * delta);
        this.updatingSpin = true;
        let changed: boolean;
        try { changed = this.controls.update(delta); }
        finally { this.updatingSpin = false; }
        if (!changed) this.stopDamping();
      }
    }
    if (this.spinZoom) {
      const p = Math.min(1, Math.max(0, (time - this.spinZoom.start) / 220));
      const radius = THREE.MathUtils.lerp(this.spinZoom.from, this.spinZoom.to, 1 - (1 - p) ** 3);
      const offset = this.camera.position.clone().sub(this.controls.target).setLength(radius);
      this.camera.position.copy(this.controls.target).add(offset);
      if (p === 1) this.spinZoom = null;
    }
    if (this.fly) {
      const p = Math.min(
          1,
          Math.max(0, (time - this.fly.start) / this.fly.duration),
        ),
        t = 1 - Math.pow(1 - p, 3);
      this.camera.position.lerpVectors(this.fly.from, this.fly.to, t);
      this.controls.target.lerpVectors(
        this.fly.targetFrom,
        this.fly.targetTo,
        t,
      );
      this.controls.update();
      if (p === 1) {
        this.fly = null;
        this.host.dataset.depthMoving = "false";
      }
    }
    this.camera.updateMatrixWorld();
    let projected: ProjectedPerson[] = [];
    const vector = new THREE.Vector3();
    const focal =
      this.height /
      (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    for (const [id, p] of this.world.points) {
      vector.set(p.x, p.y, p.z).applyMatrix4(this.camera.matrixWorldInverse);
      const distance = -vector.z;
      if (distance <= 1) continue;
      // Project the original world point, retaining billboards that intersect
      // the viewport even when their center sits just outside it.
      vector.set(p.x, p.y, p.z).project(this.camera);
      if (
        Math.abs(vector.x) > 1 + spatialCardLimit(this.width) / this.width ||
        Math.abs(vector.y) > 1 + spatialCardLimit(this.width) / this.height ||
        vector.z > 1 ||
        vector.z < -1
      )
        continue;
      projected.push({
        id,
        x: ((vector.x + 1) * this.width) / 2,
        y: ((1 - vector.y) * this.height) / 2,
        size: (220 * focal) / distance,
        distance,
        z: vector.z,
      });
    }
    let minX = this.width,
      minY = this.height,
      maxX = 0,
      maxY = 0;
    for (const p of projected) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const minimum = spatialCardFloor(
      this.width,
      projected.length,
      projected.length < 2
        ? Infinity
        : Math.max(1, maxX - minX) * Math.max(1, maxY - minY),
    );
    for (const p of projected)
      p.size = Math.max(
        minimum,
        Math.min(p.size, spatialCardLimit(this.width)),
      );
    const placement = placeSpatialCards(projected, this.width, this.height, this.cardOffsets, this.anchor);
    this.cardOffsets = new Map(placement.cards.map((p, i) => [p.id, { dx: p.x - p.anchorX, dy: p.y - p.anchorY, scale: p.size / projected[i].size }]));
    projected = placement.cards;
    this.cardProjection.update(placement.cards);
    const leaderPositions = this.leaders.geometry.getAttribute("position");
    let leaderCount = 0;
    for (const card of placement.cards) {
      const dx = card.x - card.anchorX, dy = card.y - card.anchorY;
      if (Math.hypot(dx, dy) < 3) continue;
      const point = this.world.points.get(card.id)!;
      vector.set(point.x, point.y, point.z).applyMatrix4(this.camera.matrixWorldInverse);
      vector.x += dx * card.distance / focal;
      vector.y -= dy * card.distance / focal;
      vector.applyMatrix4(this.camera.matrixWorld);
      leaderPositions.setXYZ(leaderCount * 2, point.x, point.y, point.z);
      leaderPositions.setXYZ(leaderCount * 2 + 1, vector.x, vector.y, vector.z);
      leaderCount++;
    }
    leaderPositions.needsUpdate = true;
    this.leaders.geometry.setDrawRange(0, leaderCount * 2);
    this.leaders.visible = leaderCount > 0;
    this.host.dataset.depthDisplacedCards = String(leaderCount);
    this.host.dataset.depthUnresolvedCards = String(placement.unresolved);
    this.projected = projected;
    const ids = projected.map((p) => p.id);
    this.details = new Set(ids);
    const byId = new Map(projected.map((p) => [p.id, p]));
    this.labelMask.update(projected, this.width, this.height);
    // Very large worlds keep all names. Portrait slots virtualize only beyond
    // the fixed page's 16,384-person capacity, never based on zoom or overlap.
    if (this.ids.length > this.atlas.capacity)
      this.atlas.update(ids.map((id) => this.people.get(id)!).filter(Boolean));
    const portraitIds = ids.slice(0, this.atlas.capacity);
    const centers = this.cards.geometry.getAttribute("center"),
      tiles = this.cards.geometry.getAttribute("tile"),
      layouts = this.cards.geometry.getAttribute("offset"),
      indices = this.cards.geometry.getAttribute("layoutIndex");
    portraitIds.forEach((id, i) => {
      const p = this.world.points.get(id)!;
      centers.setXYZ(i, p.x, p.y, p.z);
      layouts.setXYZW(i, 0, 0.24, 0.4, 0.4);
      indices.setX(i, this.cardProjection.indices.get(id)!);
      tiles.setXYZW(
        i,
        ...(this.atlas.uv(id) as [number, number, number, number]),
      );
    });
    centers.needsUpdate = tiles.needsUpdate = layouts.needsUpdate = indices.needsUpdate = true;
    this.cards.geometry.instanceCount = portraitIds.length;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    this.arrows.refresh(this.camera, !this.reduced.matches && navigator.hardwareConcurrency > 2 &&
      (memory === undefined || memory > 2) && !this.host.closest("[inert]"));
    this.host.dataset.depthAnimatedArrows = String(this.arrows.count);
    try {
      this.renderer.render(this.scene, this.camera);
    } catch {
      this.contextLost = true;
      this.callbacks.failure();
      return;
    }
    this.host.dataset.depthCards = String(portraitIds.length);
    this.host.dataset.depthVisiblePeople = String(projected.length);
    this.host.dataset.depthPortraitTile = String(this.atlas.tile);
    this.host.dataset.depthTextureBytes = String(
      this.cardProjection.data.byteLength + [this.atlas.canvas, this.nameAtlas.canvas, this.labelMask.canvas].reduce(
        (bytes, canvas) => bytes + canvas.width * canvas.height * 4,
        0,
      ),
    );
    this.host.dataset.depthCpuMs = String(
      Number(this.host.dataset.depthCpuMs || 0) + performance.now() - started,
    );
    this.host.dataset.depthLargestCard = String(
      Math.max(0, ...ids.map((id) => byId.get(id)!.size)),
    );
    this.host.dataset.depthDrawCalls = String(this.renderer.info.render.calls);
    this.host.dataset.depthTextures = String(
      this.renderer.info.memory.textures,
    );
    this.host.dataset.depthFrames = String(
      Number(this.host.dataset.depthFrames || 0) + 1,
    );
    this.host.dataset.depthCamera = [
      ...this.camera.position.toArray(),
      ...this.controls.target.toArray(),
    ]
      .map((v) => v.toFixed(2))
      .join(",");
    if (this.fly || this.dampingActive || this.spinZoom) this.invalidate();
    else if (this.spinActive) this.spinTimer = setTimeout(() => {
      this.spinTimer = undefined;
      this.invalidate();
    }, Math.max(0, 1000 / 30 - (performance.now() - started)));
    else this.arrows.schedule();
  };
  private drawArrowFrame = () => {
    // Reuse the uploaded scene and screen mask. Only one shader time uniform
    // changes; topology, projections and portrait/text buffers remain cached.
    if (this.frame || this.fly || this.spinActive || this.dampingActive || this.spinZoom) return;
    try { this.renderer.render(this.scene, this.camera); }
    catch { this.lost(new Event("webglcontextlost", { cancelable: true })); return; }
    this.host.dataset.depthArrowFrames = String(Number(this.host.dataset.depthArrowFrames || 0) + 1);
  };
  private move(position: THREE.Vector3, target: THREE.Vector3, duration = 620) {
    this.cancelSpin();
    this.setHover(null);
    if (this.reduced.matches || !duration) {
      this.fly = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      this.host.dataset.depthMoving = "false";
    } else {
      this.fly = {
        start: performance.now(),
        duration,
        from: this.camera.position.clone(),
        to: position,
        targetFrom: this.controls.target.clone(),
        targetTo: target,
      };
      this.host.dataset.depthMoving = "true";
    }
    this.invalidate();
  }
  focus(id: string, duration = 620) {
    const p = this.world.points.get(id);
    if (!p) return;
    const target = new THREE.Vector3(p.x, p.y, p.z);
    const distance = Math.max(
      850,
      (this.height * 220) /
        (2 *
          Math.tan(THREE.MathUtils.degToRad(42) / 2) *
          (this.width < 600 ? 130 : 165)),
    );
    const position = target
      .clone()
      .add(
        new THREE.Vector3(
          Math.sin(p.angle) * distance,
          distance * 0.25,
          Math.cos(p.angle) * distance,
        ),
      );
    this.move(position, target, this.anchor ? duration : 0);
  }
  fit = async (options?: TreeFitOptions) => {
    const ids = options?.ids?.filter((id) => this.world.points.has(id));
    if (ids?.length === 1) {
      this.focus(ids[0], options?.duration);
      return true;
    }
    const box = new THREE.Box3();
    for (const [id, p] of this.world.points)
      if (!ids || ids.includes(id))
        box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
    if (box.isEmpty()) return false;
    const target = box.getCenter(new THREE.Vector3());
    const view = new THREE.Vector3(0.55, 0.42, 1).normalize();
    const right = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), view)
      .normalize();
    const up = new THREE.Vector3().crossVectors(view, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2),
      tanH = tanV * this.camera.aspect;
    let distance = 850;
    const relative = new THREE.Vector3();
    for (const [id, p] of this.world.points)
      if (!ids || ids.includes(id)) {
        relative.set(p.x, p.y, p.z).sub(target);
        const depth = relative.dot(view);
        distance = Math.max(
          distance,
          (Math.abs(relative.dot(right)) + 150) / tanH + depth,
          (Math.abs(relative.dot(up)) + 150) / tanV + depth,
        );
      }
    this.move(
      target.clone().addScaledVector(view, distance * 1.1),
      target,
      options?.duration ?? 620,
    );
    return true;
  };
  zoom(direction: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const from = offset.length();
    offset.setLength(
      THREE.MathUtils.clamp(
        offset.length() * (direction > 0 ? 0.8 : 1.25),
        260,
        200_000,
      ),
    );
    if (this.spinActive || this.dampingActive) {
      this.spinZoom = { from, to: offset.length(), start: performance.now() };
      this.invalidate();
      return;
    }
    this.move(
      this.controls.target.clone().add(offset),
      this.controls.target.clone(),
      220,
    );
  }
  rotate(yaw: number, pitch = 0) {
    const sphere = new THREE.Spherical().setFromVector3(
      this.camera.position.clone().sub(this.controls.target),
    );
    sphere.theta += yaw;
    sphere.phi = THREE.MathUtils.clamp(
      sphere.phi + pitch,
      0.06,
      Math.PI - 0.06,
    );
    this.move(
      new THREE.Vector3().setFromSpherical(sphere).add(this.controls.target),
      this.controls.target.clone(),
      320,
    );
  }
  dispose() {
    this.stopped = true;
    this.cancelSpin();
    cancelAnimationFrame(this.frame);
    this.clearPress();
    this.observer.disconnect();
    document.removeEventListener("visibilitychange", this.visibility);
    this.reduced.removeEventListener("change", this.motionPreference);
    document.removeEventListener("pointerdown", this.documentPress, true);
    document.removeEventListener("click", this.documentClick, true);
    document.removeEventListener("keydown", this.documentKey, true);
    window.removeEventListener("blur", this.cancelSpin);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("webglcontextlost", this.lost);
    canvas.removeEventListener("webglcontextrestored", this.restored);
    canvas.removeEventListener("pointerdown", this.pointerDown);
    canvas.removeEventListener("pointermove", this.pointerMove);
    canvas.removeEventListener("pointerup", this.pointerUp);
    canvas.removeEventListener("pointercancel", this.pointerCancel);
    canvas.removeEventListener("pointerleave", this.pointerLeave);
    canvas.removeEventListener("keydown", this.keyDown);
    this.controls.removeEventListener("change", this.controlsChanged);
    this.controls.removeEventListener("start", this.controlsStarted);
    this.controls.removeEventListener("end", this.controlsEnded);
    this.controls.dispose();
    this.atlas.dispose();
    this.nameAtlas.dispose();
    this.labelMask.dispose();
    this.cardProjection.dispose();
    for (const object of [this.cards, this.names, this.edges, this.leaders]) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      materials.forEach((material) => material.dispose());
    }
    this.arrows.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }
}
