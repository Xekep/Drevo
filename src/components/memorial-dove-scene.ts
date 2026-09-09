import {
  AnimationMixer,
  DirectionalLight,
  HemisphereLight,
  LoopOnce,
  Mesh,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import doveUrl from "../assets/memorial-dove.glb?url";

/** Одна небольшая сцена: в покое нет цикла отрисовки. */
export async function createDoveScene(
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
) {
  const response = await fetch(doveUrl, { signal });
  if (!response.ok) throw new Error("Не удалось загрузить голубя");
  const gltf = await new GLTFLoader().parseAsync(
    await response.arrayBuffer(),
    "",
  );
  const root = gltf.scene;
  const disposeModel = () =>
    root.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material])
          material.dispose();
      }
    });
  if (signal.aborted) {
    disposeModel();
    throw new DOMException("Aborted", "AbortError");
  }
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
  } catch (error) {
    disposeModel();
    throw error;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(184, 184, false);
  renderer.outputColorSpace = SRGBColorSpace;
  const scene = new Scene();
  scene.add(root, new HemisphereLight(0xfffdf6, 0x899580, 2.4));
  const key = new DirectionalLight(0xfff9ee, 2.6);
  key.position.set(-0.3, 0.7, 0.5);
  scene.add(key);
  const fill = new DirectionalLight(0xe8edf4, 1.2);
  fill.position.set(0.4, 0.5, -0.2);
  scene.add(fill);
  const center = new Vector3(-0.000396, -0.016846, -0.040051);
  const camera = new OrthographicCamera(-0.375, 0.375, 0.375, -0.375, 0.01, 5);
  camera.position.copy(center).add(new Vector3(-0.7, 0.2, 0.4));
  camera.lookAt(center);
  const mixer = new AnimationMixer(root);
  const clip = gltf.animations[0];
  if (!clip) {
    disposeModel();
    renderer.dispose();
    throw new Error("Нет анимации голубя");
  }
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(0);
  try {
    renderer.render(scene, camera);
  } catch (error) {
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
    disposeModel();
    renderer.dispose();
    throw error;
  }
  let frame = 0,
    disposed = false,
    started = false;
  return {
    fly() {
      if (disposed || started) return;
      started = true;
      const start = performance.now();
      const draw = (now: number) => {
        if (disposed) return;
        const elapsed = (now - start) / 1000;
        mixer.setTime(Math.min(elapsed * 1.3, clip.duration));
        renderer.render(scene, camera);
        if (elapsed < 1.65) frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      disposeModel();
      renderer.dispose();
    },
  };
}
