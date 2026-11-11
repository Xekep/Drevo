import { useCallback, useEffect, useState } from "react";
import type { ArchivePhoto } from "../../domain/types.ts";
import { mediaPreview } from "../../domain/media-preview.ts";

function createPreloadCache() {
  const images = new Map<string, HTMLImageElement>();
  return {
    retain(urls: Set<string>) {
      for (const [url, image] of images)
        if (!urls.has(url)) {
          if (!image.complete) image.src = "";
          images.delete(url);
        }
      for (const url of urls)
        if (!images.has(url)) {
          const image = new Image();
          image.decoding = "async";
          images.set(url, image);
          image.src = url;
          // A preload failure must not stop playback; the stage owns retry/error UI.
          void image.decode().catch(() => {
            if (images.get(url) === image) images.delete(url);
          });
        }
    },
    take(url: string) {
      const image = images.get(url);
      images.delete(url);
      return image?.complete && !image.naturalWidth ? undefined : image;
    },
    dispose() {
      for (const image of images.values()) if (!image.complete) image.src = "";
      images.clear();
    },
  };
}

/** Two adjacent display images only. A consumed image transfers to the stage. */
export function useChroniclePreload(
  photos: ArchivePhoto[],
  index: number,
  enabled: boolean,
) {
  const [cache] = useState(createPreloadCache);
  useEffect(() => () => cache.dispose(), [cache]);
  useEffect(() => {
    if (!enabled || photos.length < 2) return;
    const urls = new Set(
      [
        photos[(index + 1) % photos.length],
        photos[(index - 1 + photos.length) % photos.length],
      ]
        .map((photo) => mediaPreview(photo.url, "display"))
        .filter((url): url is string => !!url),
    );
    cache.retain(urls);
  }, [photos, index, enabled, cache]);
  return useCallback((url: string) => cache.take(url), [cache]);
}
