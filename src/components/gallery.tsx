import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus } from "lucide-react";
import type { Family } from "../domain";
import { photoCaption, photoLabel } from "../domain/photo-metadata";
import { newestPhotos, photoAlbums } from "../domain/photo-albums";
import { mediaPreview } from "../domain/media-preview";
import { LoadMore } from "./load-more";
import { photoFileError } from "../domain/photo-upload";
import {
  faceRecognitionAvailable,
  warmFaceAssistant,
} from "../vision/face-assistant";
export function Gallery({
  family,
  canEdit,
  mayEdit,
  onAdd,
  onOpen,
  onDropPhoto,
  personFilter,
  onClearFilter,
}: {
  family: Family;
  canEdit: boolean;
  mayEdit: boolean;
  onAdd: () => void;
  onOpen: (id: string, photoIds: string[]) => void;
  onDropPhoto: (file: File) => void;
  personFilter?: string | null;
  onClearFilter: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState("");
  const [mode, setMode] = useState<"all" | "people" | "years">("people"),
    [albumId, setAlbumId] = useState(""),
    [limit, setLimit] = useState(30);
  useEffect(() => {
    if (!canEdit) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void faceRecognitionAvailable(controller.signal)
        .then((enabled) => {
          if (enabled && !controller.signal.aborted) return warmFaceAssistant();
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          console.error("Не удалось загрузить модель поиска лиц", error);
        });
    }, 600);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [canEdit]);
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types || []).includes("Files");
    const dialogOpen = () => !!document.querySelector("dialog[open]");
    const reset = () => setDragging(false);
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event) || dialogOpen()) return;
      event.preventDefault();
      if (canEdit) setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event) || dialogOpen()) return;
      event.preventDefault();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = canEdit ? "copy" : "none";
      if (canEdit) setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight
      )
        reset();
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      const alreadyHandled = event.defaultPrevented;
      event.preventDefault();
      reset();
      if (alreadyHandled || dialogOpen() || !canEdit) return;
      const files = event.dataTransfer?.files;
      const problem =
        files?.length !== 1
          ? "Перетащите один снимок за раз."
          : photoFileError(files[0]);
      setDropError(problem);
      if (!problem && files) onDropPhoto(files[0]);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [canEdit, onDropPhoto]);
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
    <section className="gallery-view" aria-label="Галерея семейных фотографий">
      {dragging &&
        canEdit &&
        createPortal(
          <div className="gallery-drop-overlay" role="status">
            <ImagePlus size={46} strokeWidth={1.2} />
            <b>Отпустите снимок, чтобы добавить</b>
            <span>JPG, PNG, WebP или GIF · до 20 МБ</span>
          </div>,
          document.body,
        )}
      {dropError && (
        <p className="form-error" role="alert">
          {dropError}
        </p>
      )}
      <div className="gallery-heading gallery-photo-heading">
        <div className="gallery-heading-copy">
          <span className="section-label">СЕМЕЙНЫЙ АЛЬБОМ</span>
          <h1>
            {filterPerson ? (
              <>
                Фотоальбом: {filterPerson.name} {filterPerson.surname}
              </>
            ) : (
              <>Семейный альбом</>
            )}
          </h1>
          {personFilter && (
            <button onClick={onClearFilter}>Показать все фотографии</button>
          )}
          <p>
            На фотографиях отмечены родственники. Откройте снимок, чтобы
            посмотреть, кто на нём изображён.
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
          <p>
            {mayEdit && !canEdit
              ? "Добавить фотографии можно с компьютера."
              : canEdit
                ? "Добавьте семейную фотографию и отметьте на ней людей."
                : "В архиве пока нет фотографий."}
          </p>
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
