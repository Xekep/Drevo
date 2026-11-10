import { useEffect, useRef } from "react";
import type { ArchivePhoto } from "../../domain/types";
import { photoLabel } from "../../domain/photo-metadata";

/** Original CodePen navigation layout; scroll keeps the active photo reachable in large albums. */
export function ChroniclePhotoNavigation({
  photos,
  active,
  progress,
  busy,
  onSelect,
}: {
  photos: ArchivePhoto[];
  active: number;
  progress: number;
  busy: boolean;
  onSelect: (index: number) => void;
}) {
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  }, [active]);
  return (
    <nav
      className="chronicle-slides-navigation"
      aria-label="Фотографии хроники"
    >
      {photos.map((photo, index) => (
        <button
          type="button"
          key={photo.id}
          ref={index === active ? current : undefined}
          className={`chronicle-slide-nav-item${index === active ? " active" : ""}`}
          aria-label={`Снимок ${index + 1}: ${photoLabel(photo)}`}
          aria-current={index === active ? "true" : undefined}
          disabled={busy}
          onClick={() => onSelect(index)}
        >
          <span className="chronicle-slide-progress-line" aria-hidden="true">
            <span
              className="chronicle-slide-progress-fill"
              style={{ width: `${index === active ? progress : 0}%` }}
            />
          </span>
          <span className="chronicle-slide-nav-title">
            {photo.year || photo.takenAt || "Без даты"}
          </span>
        </button>
      ))}
      <span
        className="chronicle-sr-only"
        role="progressbar"
        aria-label="Время показа снимка"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      />
    </nav>
  );
}
