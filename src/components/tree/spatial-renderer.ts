import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Person } from "../../domain";
import {
  spatialDetailIds,
  spatialCardLimit,
  type SpatialWorld,
} from "../../domain/tree-spatial";
import type { TreeFitOptions } from "./tree-camera-fit";
import {
  SpatialCardAtlas,
  SPATIAL_ATLAS_CAPACITY,
  type SpatialPalette,
} from "./spatial-card-atlas";

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
const pointVertex = `attribute vec3 color; attribute float shown; uniform float pointScale; varying vec3 vColor; varying float vShown;
void main(){vColor=color;vShown=shown;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(pointScale/max(1.,-p.z),3.,11.);}`;
const labelDeclarations =
  "uniform vec4 labelRects[32]; uniform int labelCount;";
const labelClip = `for(int i=0;i<32;i++){if(i>=labelCount)break;vec4 b=labelRects[i];if(all(greaterThanEqual(gl_FragCoord.xy,b.xy))&&all(lessThanEqual(gl_FragCoord.xy,b.zw)))discard;}`;
const pointFragment = `${labelDeclarations} varying vec3 vColor; varying float vShown;
void main(){if(vShown<.5||length(gl_PointCoord-.5)>.5)discard;${labelClip}gl_FragColor=vec4(vColor,1.);
#include <colorspace_fragment>
}`;
const cardVertex = `attribute vec3 center; attribute vec4 tile; uniform float focal; uniform float maxPixels; varying vec2 vUv;
void main(){vUv=tile.xy+uv*tile.zw;vec4 p=viewMatrix*vec4(center,1.);float scale=min(1.,maxPixels*max(1.,-p.z)/(220.*focal));p.xy+=position.xy*220.*scale;gl_Position=projectionMatrix*p;}`;
const cardFragment = `uniform sampler2D atlas; varying vec2 vUv;
void main(){vec4 c=texture2D(atlas,vUv);if(c.a<.1)discard;gl_FragColor=c;
#include <colorspace_fragment>
}`;

/** Owns the WebGL context, controls, demand-only RAF and all GPU/image resources.
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
  private dots: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private edges: THREE.LineSegments<
    THREE.BufferGeometry,
    THREE.LineBasicMaterial
  >;
  private arrows: THREE.InstancedMesh;
  private frame = 0;
  private stopped = false;
  private hidden = document.hidden;
  private contextLost = false;
  private observer: ResizeObserver;
  private width = 1;
  private height = 1;
  private projected: ProjectedPerson[] = [];
  private anchor = "";
  private active: ReadonlySet<string> = new Set();
  private details = new Set<string>();
  private labelRects = {
    value: Array.from({ length: 32 }, () => new THREE.Vector4()),
  };
  private labelCount = { value: 0 };
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
  private positions: number[] = [];
  private ids: string[];
  private indexById: Map<string, number>;
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
      "3D-древо. Стрелки — поворот, Shift и стрелки — сдвиг, плюс и минус — масштаб, Home — всё древо. Люди доступны в списке рядом.",
    );
    host.prepend(canvas);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
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
    this.controls.addEventListener("change", this.invalidate);
    this.controls.addEventListener("start", this.interrupt);
    this.ids = [...world.points.keys()];
    this.indexById = new Map(this.ids.map((id, i) => [id, i]));
    for (const p of world.points.values()) this.positions.push(p.x, p.y, p.z);
    const dotGeometry = new THREE.BufferGeometry();
    dotGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(this.positions, 3),
    );
    dotGeometry.setAttribute(
      "shown",
      new THREE.Float32BufferAttribute(
        new Float32Array(this.ids.length).fill(1),
        1,
      ),
    );
    dotGeometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        new Float32Array(this.ids.length * 3),
        3,
      ),
    );
    this.dots = new THREE.Points(
      dotGeometry,
      new THREE.ShaderMaterial({
        uniforms: {
          pointScale: { value: 16000 },
          labelRects: this.labelRects,
          labelCount: this.labelCount,
        },
        vertexShader: pointVertex,
        fragmentShader: pointFragment,
        depthTest: true,
      }),
    );
    this.scene.add(this.dots);
    const linePositions: number[] = [];
    for (const edge of world.connections) {
      const a = world.points.get(edge.from)!,
        b = world.points.get(edge.to)!;
      linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const lineGeometry = new THREE.BufferGeometry();
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
    this.scene.add(this.edges);
    const parents = world.connections.filter((e) => e.type === "parent");
    this.arrows = new THREE.InstancedMesh(
      new THREE.ConeGeometry(5, 17, 4),
      new THREE.MeshBasicMaterial({ color: palette.green }),
      parents.length,
    );
    this.maskUnderLabels(this.arrows.material as THREE.Material);
    const dummy = new THREE.Object3D(),
      direction = new THREE.Vector3();
    parents.forEach((edge, i) => {
      const a = world.points.get(edge.from)!,
        b = world.points.get(edge.to)!;
      dummy.position.set(
        a.x + (b.x - a.x) * 0.6,
        a.y + (b.y - a.y) * 0.6,
        a.z + (b.z - a.z) * 0.6,
      );
      direction.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
      dummy.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction,
      );
      dummy.updateMatrix();
      this.arrows.setMatrixAt(i, dummy.matrix);
    });
    this.arrows.computeBoundingSphere();
    this.scene.add(this.arrows);
    this.atlas = new SpatialCardAtlas(palette, this.invalidate);
    const cardGeometry = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    cardGeometry.index = plane.index;
    cardGeometry.attributes = plane.attributes;
    cardGeometry.setAttribute(
      "center",
      new THREE.InstancedBufferAttribute(
        new Float32Array(SPATIAL_ATLAS_CAPACITY * 3),
        3,
      ),
    );
    cardGeometry.setAttribute(
      "tile",
      new THREE.InstancedBufferAttribute(
        new Float32Array(SPATIAL_ATLAS_CAPACITY * 4),
        4,
      ),
    );
    cardGeometry.instanceCount = 0;
    this.cards = new THREE.Mesh(
      cardGeometry,
      new THREE.ShaderMaterial({
        uniforms: {
          atlas: { value: this.atlas.texture },
          focal: { value: 1 },
          maxPixels: { value: 190 },
        },
        vertexShader: cardVertex,
        fragmentShader: cardFragment,
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
    );
    this.cards.frustumCulled = false;
    this.cards.renderOrder = 1;
    this.scene.add(this.cards);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(host);
    document.addEventListener("visibilitychange", this.visibility);
    canvas.addEventListener("webglcontextlost", this.lost);
    canvas.addEventListener("webglcontextrestored", this.restored);
    canvas.addEventListener("pointerdown", this.pointerDown);
    canvas.addEventListener("pointermove", this.pointerMove);
    canvas.addEventListener("pointerup", this.pointerUp);
    canvas.addEventListener("pointercancel", this.pointerCancel);
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
    this.active = active;
    this.callbacks = callbacks;
    const dots = this.dots.geometry.getAttribute("color"),
      lines = this.edges.geometry.getAttribute("color");
    const green = new THREE.Color(this.palette.green),
      muted = new THREE.Color(this.palette.muted),
      red = new THREE.Color(this.palette.red);
    this.ids.forEach((id, i) =>
      dots.setXYZ(
        i,
        ...((active.has(id) ? green : muted).toArray() as [
          number,
          number,
          number,
        ]),
      ),
    );
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
    dots.needsUpdate = lines.needsUpdate = true;
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
      this.height /
      (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.cards.material.uniforms.maxPixels.value = spatialCardLimit(this.width);
    this.dots.material.uniforms.pointScale.value =
      (this.height * this.renderer.getPixelRatio() * 8) /
      Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    this.invalidate();
  };
  private maskUnderLabels(material: THREE.Material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.labelRects = this.labelRects;
      shader.uniforms.labelCount = this.labelCount;
      shader.fragmentShader =
        `${labelDeclarations}\n${shader.fragmentShader}`.replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>\n${labelClip}`,
        );
    };
  }
  private visibility = () => {
    this.hidden = document.hidden;
    if (this.hidden) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    } else this.invalidate();
  };
  private lost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.callbacks.failure();
  };
  private restored = () => {
    this.contextLost = false;
    this.invalidate();
  };
  private interrupt = () => {
    this.fly = null;
    this.host.dataset.depthMoving = "false";
  };
  private clearPress() {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }
  personAt(x: number, y: number) {
    const b = this.renderer.domElement.getBoundingClientRect();
    return [...this.projected]
      .sort(
        (a, c) =>
          Number(this.details.has(c.id)) - Number(this.details.has(a.id)) ||
          a.distance - c.distance,
      )
      .find((p) => {
        const full = this.details.has(p.id),
          width = full ? p.size * 0.5 : 13,
          height = full ? p.size * 0.5 : 13;
        return (
          Math.abs(p.x - (x - b.left)) <= width &&
          Math.abs(p.y - (y - b.top)) <= height
        );
      })?.id;
  }
  private pointerDown = (event: PointerEvent) => {
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
  private pointerCancel = () => {
    this.clearPress();
    this.pointer = null;
  };
  private keyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    let handled = true;
    if (event.key === "+" || event.key === "=") this.zoom(1);
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
    if (this.stopped || this.hidden || this.contextLost) return;
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
    const projected: ProjectedPerson[] = [],
      vector = new THREE.Vector3();
    const focal =
      this.height /
      (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    for (const [id, p] of this.world.points) {
      vector.set(p.x, p.y, p.z).applyMatrix4(this.camera.matrixWorldInverse);
      const distance = -vector.z;
      if (distance <= 1) continue;
      // Project the original world point; the view-space depth above sets LOD.
      vector.set(p.x, p.y, p.z).project(this.camera);
      if (
        Math.abs(vector.x) > 1.3 ||
        Math.abs(vector.y) > 1.3 ||
        vector.z > 1 ||
        vector.z < -1
      )
        continue;
      projected.push({
        id,
        x: ((vector.x + 1) * this.width) / 2,
        y: ((1 - vector.y) * this.height) / 2,
        size: Math.min((220 * focal) / distance, spatialCardLimit(this.width)),
        distance,
        z: vector.z,
      });
    }
    this.projected = projected;
    const ids = spatialDetailIds(
      projected,
      this.width,
      this.height,
      this.anchor,
      SPATIAL_ATLAS_CAPACITY,
    );
    const shown = this.dots.geometry.getAttribute("shown");
    for (const id of this.details) shown.setX(this.indexById.get(id)!, 1);
    for (const id of ids) shown.setX(this.indexById.get(id)!, 0);
    shown.needsUpdate = true;
    this.details = new Set(ids);
    const byId = new Map(projected.map((p) => [p.id, p]));
    const dpr = this.renderer.getPixelRatio();
    ids.forEach((id, i) => {
      const p = byId.get(id)!,
        half = p.size / 2 + 3;
      this.labelRects.value[i].set(
        (p.x - half) * dpr,
        (this.height - p.y - half) * dpr,
        (p.x + half) * dpr,
        (this.height - p.y + half) * dpr,
      );
    });
    this.labelCount.value = ids.length;
    this.atlas.update(ids.map((id) => this.people.get(id)!).filter(Boolean));
    const centers = this.cards.geometry.getAttribute("center"),
      tiles = this.cards.geometry.getAttribute("tile");
    ids.forEach((id, i) => {
      const p = this.world.points.get(id)!;
      centers.setXYZ(i, p.x, p.y, p.z);
      tiles.setXYZW(
        i,
        ...(this.atlas.uv(id) as [number, number, number, number]),
      );
    });
    centers.needsUpdate = tiles.needsUpdate = true;
    this.cards.geometry.instanceCount = ids.length;
    try {
      this.renderer.render(this.scene, this.camera);
    } catch {
      this.contextLost = true;
      this.callbacks.failure();
      return;
    }
    this.host.dataset.depthCards = String(ids.length);
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
    if (this.fly) this.invalidate();
  };
  private move(position: THREE.Vector3, target: THREE.Vector3, duration = 620) {
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
    offset.setLength(
      THREE.MathUtils.clamp(
        offset.length() * (direction > 0 ? 0.8 : 1.25),
        260,
        200_000,
      ),
    );
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
    cancelAnimationFrame(this.frame);
    this.clearPress();
    this.observer.disconnect();
    document.removeEventListener("visibilitychange", this.visibility);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("webglcontextlost", this.lost);
    canvas.removeEventListener("webglcontextrestored", this.restored);
    canvas.removeEventListener("pointerdown", this.pointerDown);
    canvas.removeEventListener("pointermove", this.pointerMove);
    canvas.removeEventListener("pointerup", this.pointerUp);
    canvas.removeEventListener("pointercancel", this.pointerCancel);
    canvas.removeEventListener("keydown", this.keyDown);
    this.controls.dispose();
    this.atlas.dispose();
    for (const object of [this.cards, this.dots, this.edges, this.arrows]) {
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
