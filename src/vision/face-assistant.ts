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
const MODEL_URI = "/models/face-api-1.7.15";
let engine: Promise<typeof import("@vladmandic/face-api")> | undefined,
  quickModels: Promise<void> | undefined,
  preciseModel: Promise<void> | undefined;
const cache = new Map<string, Promise<FaceSample[]>>();
async function loadApi() {
  if (!engine)
    engine = (async () => {
      const api = await import("@vladmandic/face-api");
      await (api.tf as unknown as { ready: () => Promise<void> }).ready();
      return api;
    })().catch((e) => {
      engine = undefined;
      throw e;
    });
  return engine;
}

async function loadQuickEngine() {
  const api = await loadApi();
  if (!quickModels)
    quickModels = Promise.all([
      api.nets.tinyFaceDetector.loadFromUri(MODEL_URI),
      api.nets.faceLandmark68Net.loadFromUri(MODEL_URI),
      api.nets.faceRecognitionNet.loadFromUri(MODEL_URI),
    ])
      .then(() => undefined)
      .catch((error) => {
        quickModels = undefined;
        throw error;
      });
  await quickModels;
  return api;
}

async function loadPreciseEngine() {
  const api = await loadQuickEngine();
  if (!preciseModel)
    preciseModel = api.nets.ssdMobilenetv1
      .loadFromUri(MODEL_URI)
      .catch((error) => {
        preciseModel = undefined;
        throw error;
      });
  await preciseModel;
  return api;
}

export async function warmFaceAssistant() {
  await loadQuickEngine();
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
    const api = precise ? await loadPreciseEngine() : await loadQuickEngine();
    const image = new Image();
    image.src = url;
    await image.decode();
    let canvas = imageCanvas(image, precise ? 1800 : 1200);
    let result = precise
      ? await api
          .detectAllFaces(
            canvas,
            new api.SsdMobilenetv1Options({
              minConfidence: 0.55,
              maxResults: 100,
            }),
          )
          .withFaceLandmarks()
          .withFaceDescriptors()
      : await api
          .detectAllFaces(
            canvas,
            new api.TinyFaceDetectorOptions({
              inputSize: 608,
              scoreThreshold: 0.45,
            }),
          )
          .withFaceLandmarks()
          .withFaceDescriptors();
    if (!precise && !result.length) {
      onProgress("Быстрый поиск не нашёл лиц — запускаем точный…");
      await loadPreciseEngine();
      canvas = imageCanvas(image, 1800);
      result = await api
        .detectAllFaces(
          canvas,
          new api.SsdMobilenetv1Options({
            minConfidence: 0.55,
            maxResults: 100,
          }),
        )
        .withFaceLandmarks()
        .withFaceDescriptors();
    }
    return result
      .map((face) => {
        const b = face.detection.box,
          x = Math.max(0, b.x / canvas.width),
          y = Math.max(0, b.y / canvas.height);
        return {
          box: {
            x,
            y,
            width: Math.min(1 - x, b.width / canvas.width),
            height: Math.min(1 - y, b.height / canvas.height),
          },
          descriptor: Array.from(face.descriptor),
        };
      })
      .filter((f) => f.box.width > 0 && f.box.height > 0);
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
    body: JSON.stringify({ descriptor }),
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
) {
  const response = await fetch("/api/faces/descriptors", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: crypto.randomUUID(), personId, descriptor }),
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
