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
export type StoredFaceDescriptor = {
  id: string;
  personId: string;
  descriptor: number[];
};
export type FaceSuggestion = {
  id: string;
  box: FaceRect;
  descriptor: number[];
  match?: { personId: string; distance: number };
};
const MATCH_DISTANCE = 0.52;
let engine: Promise<typeof import("@vladmandic/face-api")> | undefined;
const cache = new Map<string, Promise<FaceSample[]>>();
function closestMatch(descriptor: number[], known: StoredFaceDescriptor[]) {
  let match: { personId: string; distance: number } | undefined;
  for (const sample of known) {
    if (sample.descriptor.length !== descriptor.length) continue;
    let squared = 0;
    for (let index = 0; index < descriptor.length; index++)
      squared += (descriptor[index] - sample.descriptor[index]) ** 2;
    const distance = Math.sqrt(squared);
    if (!match || distance < match.distance)
      match = { personId: sample.personId, distance };
  }
  return match && match.distance <= MATCH_DISTANCE ? match : undefined;
}
async function loadEngine() {
  if (!engine)
    engine = (async () => {
      const api = await import("@vladmandic/face-api");
      await (api.tf as unknown as { ready: () => Promise<void> }).ready();
      await Promise.all([
        api.nets.ssdMobilenetv1.loadFromUri("/models"),
        api.nets.faceLandmark68Net.loadFromUri("/models"),
        api.nets.faceRecognitionNet.loadFromUri("/models"),
      ]);
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
    const result = await api
      .detectAllFaces(
        canvas,
        new api.SsdMobilenetv1Options({ minConfidence: 0.55, maxResults: 100 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptors();
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
    cache.delete(url);
    throw error;
  });
  cache.set(url, work);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return work;
}
export async function loadFaceDescriptors(): Promise<StoredFaceDescriptor[]> {
  const response = await fetch("/api/faces/descriptors", {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Не удалось загрузить отпечатки лиц");
  const value: unknown = await response.json();
  if (!Array.isArray(value))
    throw new Error("Некорректный ответ отпечатков лиц");
  return value.filter(
    (item): item is StoredFaceDescriptor =>
      !!item &&
      typeof item === "object" &&
      typeof (item as StoredFaceDescriptor).id === "string" &&
      typeof (item as StoredFaceDescriptor).personId === "string" &&
      Array.isArray((item as StoredFaceDescriptor).descriptor) &&
      (item as StoredFaceDescriptor).descriptor.length === 128 &&
      (item as StoredFaceDescriptor).descriptor.every(Number.isFinite),
  );
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
  known: StoredFaceDescriptor[],
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
      descriptor: face.descriptor,
      match: closestMatch(face.descriptor, known),
    }));
}
