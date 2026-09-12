import { Human } from "@vladmandic/human";

const MODEL_URI = "/models/human-3.3.6";

type Tag = {
  id: string;
  personId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
type Photo = { id: string; file: string; tags: Tag[] };

function contains(
  tag: Tag,
  box: { x: number; y: number; width: number; height: number },
) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return (
    x >= tag.x &&
    x <= tag.x + tag.width &&
    y >= tag.y &&
    y <= tag.y + tag.height
  );
}

async function run() {
  const photos = (await fetch("/__face_backfill/manifest").then((response) =>
    response.json(),
  )) as Photo[];
  const human = new Human({
    modelBasePath: MODEL_URI,
    face: {
      enabled: true,
      detector: { rotation: true, maxDetected: 100, minConfidence: 0.3 },
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
  const descriptors: Array<{
    id: string;
    personId: string;
    descriptor: number[];
    sourcePhotoId: string;
    model: string;
  }> = [];
  let unmatched = 0;
  const errors: string[] = [];
  for (const photo of photos) {
    try {
      const image = new Image();
      image.src = `/__face_backfill/uploads/${encodeURIComponent(photo.file)}`;
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
      const faces = (await human.detect(canvas)).face;
      for (const tag of photo.tags) {
        const face = faces.find((candidate) => {
          const box = candidate.boxRaw;
          return contains(tag, {
            x: box[0],
            y: box[1],
            width: box[2],
            height: box[3],
          });
        });
        if (!face?.embedding || face.embedding.length !== 1024) {
          unmatched++;
          continue;
        }
        descriptors.push({
          id: `tag:${photo.id}:${tag.id}`,
          personId: tag.personId,
          descriptor: face.embedding,
          sourcePhotoId: photo.id,
          model: "human-faceres-3.3.6",
        });
      }
    } catch (error) {
      errors.push(
        `${photo.id}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  await fetch("/__face_backfill/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      descriptors,
      report: {
        photos: photos.length,
        tags: photos.reduce((sum, photo) => sum + photo.tags.length, 0),
        saved: descriptors.length,
        unmatched,
        errors,
      },
    }),
  });
  document.body.textContent = "done";
}

void run().catch(async (error) => {
  await fetch("/__face_backfill/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      descriptors: [],
      report: {
        fatal: error instanceof Error ? error.message : "unknown error",
      },
    }),
  });
});
