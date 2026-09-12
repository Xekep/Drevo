import * as faceapi from "@vladmandic/face-api";

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
  await (faceapi.tf as unknown as { ready: () => Promise<void> }).ready();
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
    faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
    faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
  ]);
  const descriptors: Array<{
    id: string;
    personId: string;
    descriptor: number[];
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
      const faces = await faceapi
        .detectAllFaces(
          canvas,
          new faceapi.SsdMobilenetv1Options({
            minConfidence: 0.55,
            maxResults: 100,
          }),
        )
        .withFaceLandmarks()
        .withFaceDescriptors();
      for (const tag of photo.tags) {
        const face = faces.find((candidate) => {
          const box = candidate.detection.box;
          return contains(tag, {
            x: box.x / canvas.width,
            y: box.y / canvas.height,
            width: box.width / canvas.width,
            height: box.height / canvas.height,
          });
        });
        if (!face) {
          unmatched++;
          continue;
        }
        descriptors.push({
          id: `tag:${photo.id}:${tag.id}`,
          personId: tag.personId,
          descriptor: Array.from(face.descriptor),
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
