type FaceRect = { x: number; y: number; width: number; height: number };
type FaceSample = { box: FaceRect; descriptor: number[] };
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
export type FaceSuggestion = {
  id: string;
  box: FaceRect;
  descriptor: number[];
  match?: { personId: string; distance: number };
};
export const FACE_MODEL = "human-faceres-3.3.6";
const MODEL_URI = "/models/human-3.3.6";
let engine:
  | Promise<InstanceType<(typeof import("@vladmandic/human"))["Human"]>>
  | undefined;
const cache = new Map<string, Promise<FaceSample[]>>();
async function loadApi() {
  if (!engine)
    engine = (async () => {
      const { Human } = await import("@vladmandic/human");
      const human = new Human({
        modelBasePath: MODEL_URI,
        cacheModels: true,
        face: {
          enabled: true,
          detector: {
            rotation: true,
            maxDetected: 100,
            minConfidence: 0.45,
          },
          mesh: { enabled: true },
          description: { enabled: true },
          iris: { enabled: false },
          emotion: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
        segmentation: { enabled: false },
      });
      await human.load();
      return human;
    })().catch((e) => {
      engine = undefined;
      throw e;
    });
  return engine;
}

export async function warmFaceAssistant() {
  await loadApi();
}

function imageCanvas(image: HTMLImageElement, maximumSide: number) {
  const scale = Math.min(
    1,
    maximumSide / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function detect(
  url: string,
  precise: boolean,
  onProgress: (message: string) => void,
): Promise<FaceSample[]> {
  const key = `${precise ? "precise" : "quick"}:${url}`;
  if (cache.has(key)) return cache.get(key)!;
  const work = (async () => {
    const human = await loadApi();
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = imageCanvas(image, precise ? 1800 : 1200);
    if (human.config.face.detector)
      human.config.face.detector.minConfidence = precise ? 0.3 : 0.45;
    const result = await human.detect(canvas);
    if (!precise && !result.face.length)
      onProgress("Лица не найдены — попробуйте точный режим…");
    return result.face
      .map((face) => {
        const [rawX, rawY, rawWidth, rawHeight] = face.boxRaw,
          x = Math.max(0, rawX),
          y = Math.max(0, rawY);
        return {
          box: {
            x,
            y,
            width: Math.min(1 - x, rawWidth),
            height: Math.min(1 - y, rawHeight),
          },
          descriptor: face.embedding || [],
        };
      })
      .filter(
        (f) =>
          f.box.width > 0 &&
          f.box.height > 0 &&
          f.descriptor.length === 1024,
      );
  })().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, work);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return work;
}
async function matchFaceDescriptor(
  descriptor: number[],
  signal: AbortSignal,
): Promise<{ personId: string; distance: number } | undefined> {
  const response = await fetch("/api/faces/match", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ descriptor, model: FACE_MODEL }),
    signal,
  });
  if (!response.ok) throw new Error("Не удалось сравнить отпечаток лица");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Некорректный ответ сравнения лиц");
  const match = (value as { match?: unknown }).match;
  if (match === null) return undefined;
  if (
    !match ||
    typeof match !== "object" ||
    Array.isArray(match) ||
    typeof (match as { personId?: unknown }).personId !== "string" ||
    typeof (match as { distance?: unknown }).distance !== "number" ||
    !Number.isFinite((match as { distance: number }).distance)
  )
    throw new Error("Некорректный ответ сравнения лиц");
  return match as { personId: string; distance: number };
}

export async function saveFaceDescriptor(
  personId: string,
  descriptor: number[],
  sourcePhotoId: string,
) {
  const response = await fetch("/api/faces/descriptors", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      personId,
      descriptor,
      sourcePhotoId,
      model: FACE_MODEL,
    }),
  });
  if (!response.ok) throw new Error("Не удалось сохранить отпечаток лица");
}

export async function suggestFaces(
  photo: ArchivePhoto,
  signal: AbortSignal,
  onProgress: (message: string) => void,
  precise = false,
): Promise<FaceSuggestion[]> {
  const check = () => {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  };
  check();
  onProgress(precise ? "Ищем лица в точном режиме…" : "Ищем лица на снимке…");
  const faces = await detect(photo.url, precise, onProgress);
  check();
  const newFaces = faces.filter(
    (face) => !photo.tags.some((tag) => containsFace(tag, face.box)),
  );
  if (newFaces.length) onProgress("Сравниваем найденные лица…");
  const suggestions: FaceSuggestion[] = [];
  for (const face of newFaces) {
    check();
    suggestions.push({
      id: crypto.randomUUID(),
      box: face.box,
      descriptor: face.descriptor,
      match: await matchFaceDescriptor(face.descriptor, signal),
    });
  }
  return suggestions;
}
