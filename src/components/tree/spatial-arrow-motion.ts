import * as THREE from "three";
import type { SpatialWorld } from "../../domain/tree-spatial";
import { setSpatialEdgeEndpoints } from "./spatial-edge-occlusion.ts";

export const ARROW_MOTION_RADIUS = 2200;
export const ARROW_MOTION_LIMIT = 64;

/** Clips real parent edges to a sphere around the camera. No new relations. */
export function nearbyArrowRanges(world: SpatialWorld, camera: { x: number; y: number; z: number }) {
  const candidates: { index: number; from: number; to: number; distance: number }[] = [];
  let index = 0;
  for (const edge of world.connections) {
    if (edge.type !== "parent") continue;
    const arrowIndex = index++;
    const a = world.points.get(edge.from)!, b = world.points.get(edge.to)!;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const ax = a.x - camera.x, ay = a.y - camera.y, az = a.z - camera.z;
    const length2 = dx * dx + dy * dy + dz * dz;
    if (!length2) continue;
    const dot = ax * dx + ay * dy + az * dz;
    const center = -dot / length2;
    const discriminant = dot * dot - length2 * (ax * ax + ay * ay + az * az - ARROW_MOTION_RADIUS ** 2);
    if (discriminant <= 0) continue;
    const half = Math.sqrt(discriminant) / length2;
    const from = Math.max(0.12, center - half), to = Math.min(0.88, center + half);
    if (to - from < 0.02) continue;
    const t = Math.max(from, Math.min(to, center));
    const distance = (ax + dx * t) ** 2 + (ay + dy * t) ** 2 + (az + dz * t) ** 2;
    // Keep only the closest fixed-size set, rather than sorting/allocating a
    // candidate for every edge in a dense archive on each camera update.
    if (candidates.length === ARROW_MOTION_LIMIT && distance >= candidates[candidates.length - 1].distance) continue;
    let low = 0, high = candidates.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[middle].distance <= distance) low = middle + 1;
      else high = middle;
    }
    candidates.splice(low, 0, { index: arrowIndex, from, to, distance });
    if (candidates.length > ARROW_MOTION_LIMIT) candidates.pop();
  }
  return candidates;
}

/** Uniform-only motion: no camera projection, image upload or React work per tick. */
export class SpatialArrowMotion {
  readonly mesh: THREE.InstancedMesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  private time = { value: 0 };
  private ranges: THREE.InstancedBufferAttribute;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;
  private world: SpatialWorld;
  private draw: () => void;
  private visible: () => boolean;
  count = 0;
  constructor(world: SpatialWorld, color: string,
    draw: () => void, visible: () => boolean) {
    this.world = world;
    this.draw = draw;
    this.visible = visible;
    const parents = world.connections.filter(e => e.type === "parent");
    const geometry = new THREE.ConeGeometry(5, 17, 4);
    setSpatialEdgeEndpoints(geometry, world, parents, true);
    this.ranges = new THREE.InstancedBufferAttribute(new Float32Array(parents.length * 3), 3);
    const deltas = new THREE.InstancedBufferAttribute(new Float32Array(parents.length * 3), 3);
    geometry.setAttribute("flowRange", this.ranges);
    geometry.setAttribute("edgeDelta", deltas);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true });
    material.onBeforeCompile = shader => {
      shader.uniforms.flowTime = this.time;
      shader.vertexShader = `attribute vec3 flowRange; attribute vec3 edgeDelta; uniform float flowTime; varying float flowAlpha;\n${shader.vertexShader}`
        .replace("#include <project_vertex>", `#include <project_vertex>
float cycle=fract(flowTime+flowRange.z);
float phase=flowRange.y>flowRange.x?mix(flowRange.x,flowRange.y,cycle):.6;
flowAlpha=flowRange.y>flowRange.x?smoothstep(0.,.12,cycle)*(1.-smoothstep(.88,1.,cycle)):1.;
mvPosition.xyz+=(modelViewMatrix*vec4(edgeDelta*(phase-.6),0.)).xyz;
gl_Position=projectionMatrix*mvPosition;`);
      shader.fragmentShader = `varying float flowAlpha;\n${shader.fragmentShader}`
        .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a*=flowAlpha;if(diffuseColor.a<.02)discard;");
    };
    this.mesh = new THREE.InstancedMesh(geometry, material, parents.length);
    // Instance centres move along their complete edge, beyond the static cones.
    this.mesh.frustumCulled = false;
    const dummy = new THREE.Object3D(), direction = new THREE.Vector3();
    parents.forEach((edge, i) => {
      const a = world.points.get(edge.from)!, b = world.points.get(edge.to)!;
      direction.set(b.x - a.x, b.y - a.y, b.z - a.z);
      deltas.setXYZ(i, direction.x, direction.y, direction.z);
      dummy.position.set(a.x, a.y, a.z).addScaledVector(direction, .6);
      dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    });
  }
  refresh(camera: THREE.Camera, enabled: boolean) {
    this.stop();
    this.ranges.array.fill(0);
    const ranges = enabled ? nearbyArrowRanges(this.world, camera.position) : [];
    for (const range of ranges)
      this.ranges.setXYZ(range.index, range.from, range.to, (range.index * .61803398875) % 1);
    this.count = ranges.length;
    this.ranges.needsUpdate = true;
    this.time.value = performance.now() / 2200;
  }
  schedule() {
    if (!this.count || this.timer !== undefined || this.frame) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.frame = requestAnimationFrame(time => {
        this.frame = 0;
        if (!this.visible()) { this.stop(); return; }
        this.time.value = time / 2200;
        this.draw();
        this.schedule();
      });
    }, 1000 / 30);
  }
  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
  dispose() {
    this.stop();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
