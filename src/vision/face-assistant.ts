type FaceRect = { x: number; y: number; width: number; height: number };
type FaceSample = { box: FaceRect };
function containsFace(tag: FaceRect, face: FaceRect) {
  const x = face.x + face.width / 2,
    y = face.y + face.height / 2;
  return (
    x >= tag.x &&
    x <= tag.x + tag.width &&
    y >= tag.y &&
    y <= tag.y + tag.height
  );
}
import type { ArchivePhoto } from "../domain";
export type FaceSuggestion = { id: string; box: FaceRect; personId?: string };
let engine: Promise<typeof import("@vladmandic/face-api")> | undefined;
const cache = new Map<string, Promise<FaceSample[]>>();
async function loadEngine() {
  if (!engine)
    engine = (async () => {
      const api = await import("@vladmandic/face-api");
      await (api.tf as unknown as { ready: () => Promise<void> }).ready();
      await Promise.all([api.nets.ssdMobilenetv1.loadFromUri("/models")]);
      return api;
    })().catch((e) => {
      engine = undefined;
      throw e;
    });
  return engine;
}
async function detect(url: string): Promise<FaceSample[]> {
  if (cache.has(url)) return cache.get(url)!;
  const work = (async () => {
    const api = await loadEngine(),
      image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(
      1,
      1800 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas
      .getContext("2d")!
      .drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = await api.detectAllFaces(
      canvas,
      new api.SsdMobilenetv1Options({ minConfidence: 0.55, maxResults: 100 }),
    );
    return result
      .map((face) => {
        const b = face.box,
          x = Math.max(0, b.x / canvas.width),
          y = Math.max(0, b.y / canvas.height);
        return {
          box: {
            x,
            y,
            width: Math.min(1 - x, b.width / canvas.width),
            height: Math.min(1 - y, b.height / canvas.height),
          },
        };
      })
      .filter((f) => f.box.width > 0 && f.box.height > 0);
  })().catch((error) => {
    cache.delete(url);
    throw error;
  });
  cache.set(url, work);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return work;
}
export async function suggestFaces(
  photo: ArchivePhoto,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<FaceSuggestion[]> {
  const check = () => {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  };
  check();
  onProgress("Ищем лица на снимке…");
  const faces = await detect(photo.url);
  check();
  return faces
    .filter((face) => !photo.tags.some((tag) => containsFace(tag, face.box)))
    .map((face) => ({
      id: crypto.randomUUID(),
      box: face.box,
    }));
}
