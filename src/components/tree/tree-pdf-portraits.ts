import { archiveFetch } from "../../data/archive-fetch.ts";
import { mediaPreview } from "../../domain/media-preview.ts";

/** Cached 1024px centre crops avoid downloading/decoding full-size local photos.
 * At most four jobs; repeated people/photos share one encoded portrait per export.
 * Nothing is cached between archives, access scopes or subsequent downloads.
 */
export async function prepareTreePdfPortraits(
  target: Document,
  sources: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const urls = [...new Set([...sources.values()].filter(Boolean))];
  const portraits = new Map<string, string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, urls.length) }, async () => {
      while (next < urls.length) {
        signal.throwIfAborted();
        const url = urls[next++];
        const response = await archiveFetch(mediaPreview(url, "print")!, { signal });
        if (!response.ok)
          throw new Error("Не удалось загрузить портрет для экспорта.");
        const blob = await response.blob();
        signal.throwIfAborted();
        const objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        const canvas = target.createElement("canvas");
        const abort = () => {
          image.src = "";
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          image.src = objectUrl;
          await image.decode();
          signal.throwIfAborted();
          const crop = Math.min(image.naturalWidth, image.naturalHeight);
          canvas.width = canvas.height = Math.min(1024, Math.max(256, crop));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Браузер не смог подготовить портрет.");
          context.beginPath();
          context.arc(
            canvas.width / 2,
            canvas.height / 2,
            canvas.width / 2,
            0,
            2 * Math.PI,
          );
          context.clip();
          context.drawImage(
            image,
            (image.naturalWidth - crop) / 2,
            (image.naturalHeight - crop) / 2,
            crop,
            crop,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          portraits.set(url, canvas.toDataURL("image/png"));
        } finally {
          signal.removeEventListener("abort", abort);
          image.src = "";
          canvas.width = canvas.height = 0;
          URL.revokeObjectURL(objectUrl);
        }
      }
    }),
  );
  signal.throwIfAborted();
  return new Map(
    [...sources].flatMap(([id, url]) => {
      const portrait = portraits.get(url);
      return portrait ? [[id, portrait]] : [];
    }),
  );
}
