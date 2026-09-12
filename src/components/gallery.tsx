import { useEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import type { Family } from "../domain";
import { photoCaption, photoLabel } from "../domain/photo-metadata";
import { newestPhotos, photoAlbums } from "../domain/photo-albums";
import { mediaPreview } from "../domain/media-preview";
import { LoadMore } from "./load-more";
import { photoFileError } from "../domain/photo-upload";
import { warmFaceAssistant } from "../vision/face-assistant";
export function Gallery({
  family,
  canEdit,
  onAdd,
  onOpen,
  onDropPhoto,
  personFilter,
  onClearFilter,
}: {
  family: Family;
  canEdit: boolean;
  onAdd: () => void;
  onOpen: (id: string, photoIds: string[]) => void;
  onDropPhoto: (file: File) => void;
  personFilter?: string | null;
  onClearFilter: () => void;
}) {
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState("");
  const [mode, setMode] = useState<"all" | "people" | "years">("all"),
    [albumId, setAlbumId] = useState(""),
    [limit, setLimit] = useState(30);
  useEffect(() => {
    if (!canEdit) return;
    const timer = window.setTimeout(() => {
      void warmFaceAssistant().catch(() => {});
    }, 600);
    return () => window.clearTimeout(timer);
  }, [canEdit]);
  const available = (family.photos || []).filter(
    (photo) =>
      !personFilter || photo.tags.some((t) => t.personId === personFilter),
  );
  const albums =
    mode === "all" ? [] : photoAlbums(available, family.people, mode);
  const album = albums.find((item) => item.id === albumId);
  const photos = album ? album.photos : newestPhotos(available);
  const browsingAlbums = mode !== "all" && !album;
  const filterPerson = family.people.find((p) => p.id === personFilter);
  return (
    <section
      className={`gallery-view ${dragging && canEdit ? "is-file-dragging" : ""}`}
      aria-label="Галерея семейных фотографий"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        if (canEdit) {
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = canEdit ? "copy" : "none";
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!canEdit) return;
        const files = e.dataTransfer.files;
        const problem =
          files.length !== 1
            ? "Перетащите один снимок за раз."
            : photoFileError(files[0]);
        setDropError(problem);
        if (!problem) onDropPhoto(files[0]);
      }}
    >
      {dragging && canEdit && (
        <div className="gallery-drop-overlay" role="status">
          <ImagePlus size={46} strokeWidth={1.2} />
          <b>Отпустите снимок, чтобы добавить</b>
          <span>JPG, PNG, WebP или GIF · до 20 МБ</span>
        </div>
      )}
      {dropError && (
        <p className="form-error" role="alert">
          {dropError}
        </p>
      )}
      <div className="gallery-heading gallery-photo-heading">
        <div className="gallery-heading-copy">
          <span className="section-label">СЕМЕЙНЫЙ АЛЬБОМ</span>
          <h2>
            {filterPerson ? (
              <>
                <span className="gallery-title-desktop">
                  Фотоальбом: {filterPerson.name} {filterPerson.surname}
                </span>
                <span className="gallery-title-mobile">
                  {filterPerson.name} {filterPerson.surname}
                </span>
              </>
            ) : (
              <>
                <span className="gallery-title-desktop">
                  Лица нашей истории
                </span>
                <span className="gallery-title-mobile">Семейный альбом</span>
              </>
            )}
          </h2>
          {personFilter && (
            <button onClick={onClearFilter}>Показать все фотографии</button>
          )}
          <p>
            Один снимок — несколько историй. Откройте фото, чтобы узнать людей
            на нём.
          </p>
        </div>
        <div className="gallery-heading-actions">
          <div
            className="gallery-modes segmented"
            aria-label="Группировка фотографий"
          >
            {(
              [
                ["all", "Все · по добавлению", "Все"],
                ["people", "По людям", "Люди"],
                ["years", "По годам", "Годы"],
              ] as const
            ).map(([value, label, compactLabel]) => (
              <button
                key={value}
                aria-label={label}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  setAlbumId("");
                  setLimit(30);
                }}
              >
                <span className="gallery-mode-label">{label}</span>
                <span className="gallery-mode-label-compact" aria-hidden="true">
                  {compactLabel}
                </span>
              </button>
            ))}
          </div>
          {canEdit && (
            <button className="primary-action" onClick={onAdd}>
              <ImagePlus size={18} />
              Добавить фото
            </button>
          )}
        </div>
      </div>
      {album && (
        <div className="album-heading">
          <button
            onClick={() => {
              setAlbumId("");
              setLimit(30);
            }}
          >
            ← Все альбомы
          </button>
          <h3>
            {album.label} · {album.photos.length}
          </h3>
        </div>
      )}
      {!photos.length ? (
        <div className="gallery-empty">
          <ImagePlus size={42} strokeWidth={1} />
          <h3>Первые страницы альбома</h3>
          <p>Добавьте семейную фотографию и отметьте на ней людей.</p>
        </div>
      ) : browsingAlbums ? (
        <div className="photo-albums">
          {albums.slice(0, limit).map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setAlbumId(item.id);
                setLimit(30);
              }}
            >
              <img
                src={mediaPreview(item.photos[0].url)}
                alt=""
                loading="lazy"
              />
              <span>
                <b>{item.label}</b>
                <small>{item.photos.length} фото</small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="photo-grid">
          {photos.slice(0, limit).map((photo) => (
            <button
              className="photo-tile"
              key={photo.id}
              onClick={() =>
                onOpen(
                  photo.id,
                  photos.map((p) => p.id),
                )
              }
            >
              <img
                src={mediaPreview(photo.url)}
                alt={photoLabel(photo)}
                loading="lazy"
              />
              {(photoCaption(photo) || photo.tags.length > 0) && (
                <span>
                  {[photo.year || photo.takenAt, photo.place, photo.event].some(
                    (value) => value?.trim(),
                  ) && (
                    <small>
                      {[photo.year || photo.takenAt, photo.place, photo.event]
                        .filter((value) => value?.trim())
                        .join(" · ")}
                    </small>
                  )}
                  {photo.tags.length > 0 && (
                    <small>Отметок: {photo.tags.length}</small>
                  )}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {(browsingAlbums ? albums.length : photos.length) > limit && (
        <LoadMore onMore={() => setLimit((n) => n + 30)} />
      )}
    </section>
  );
}
