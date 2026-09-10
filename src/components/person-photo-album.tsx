import { ChevronRight, Images } from "lucide-react";
import type { ArchivePhoto } from "../domain";
import { newestPhotos } from "../domain/photo-albums";
import { mediaPreview } from "../domain/media-preview";

export function PersonPhotoAlbum({
  photos,
  onOpen,
}: {
  photos: ArchivePhoto[];
  onOpen: () => void;
}) {
  return (
    <button
      className="person-album-stack"
      onClick={onOpen}
      aria-label={`Открыть фотоальбом человека: ${photos.length} фото`}
    >
      {photos.length > 0 && (
        <span className="album-stack-pictures" aria-hidden="true">
          {newestPhotos(photos)
            .slice(0, 3)
            .map((photo) => (
              <img
                key={photo.id}
                src={mediaPreview(photo.url)}
                alt=""
                loading="lazy"
              />
            ))}
        </span>
      )}
      <span className="album-stack-caption">
        <Images size={18} />
        <span>
          Фотоальбом <small>{photos.length} фото</small>
        </span>
        <ChevronRight size={18} />
      </span>
    </button>
  );
}
