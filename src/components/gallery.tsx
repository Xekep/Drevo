import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus } from "lucide-react";
import type { Family } from "../domain";
import { photoCaption, photoLabel } from "../domain/photo-metadata";
import { newestPhotos, photoAlbums } from "../domain/photo-albums";
import { mediaPreview } from "../domain/media-preview";
import { LoadMore } from "./load-more";
import { photoFileError } from "../domain/photo-upload";
import { ArchiveLink } from "./archive-link";
import { archiveTargetPath } from "../domain/archive-links";
import { scopedArchivePath } from "../domain/archive-context";
import type {
  GalleryPage,
  GalleryQuery,
} from "../domain/archive-view-projection";
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
  yearFilter,
  onSelectAlbum,
  loadPage,
  dataGeneration,
}: {
  family: Family;
  canEdit: boolean;
  mayEdit: boolean;
  onAdd: () => void;
  onOpen: (id: string, photoIds: string[]) => void;
  onDropPhoto: (file: File) => void;
  personFilter?: string | null;
  yearFilter?: string | null;
  loadPage?: (query: GalleryQuery) => Promise<GalleryPage>;
  dataGeneration?: number;
  onSelectAlbum: (
    personId: string | null,
    year: string | null,
    replace?: boolean,
  ) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState("");
  const [mode, setMode] = useState<"all" | "people" | "years">("people"),
    [limit, setLimit] = useState(30);
  const [remote, setRemote] = useState<{
    key: string;
    page: GalleryPage;
  } | null>(null);
  const [pageLoading, setPageLoading] = useState(false),
    [pageError, setPageError] = useState("");
  const [retry, setRetry] = useState(0);
  const pageRequest = useRef(0),
    pagePending = useRef(false);
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
      if (mayEdit) setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event) || dialogOpen()) return;
      event.preventDefault();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = mayEdit ? "copy" : "none";
      if (mayEdit) setDragging(true);
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
      if (alreadyHandled || dialogOpen() || !mayEdit) return;
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
  }, [mayEdit, onDropPhoto]);
  const knownPeople = !loadPage && personFilter === "unknown" ? new Set(family.people.map((person) => person.id)) : null;
  const available = loadPage ? [] : (family.photos || []).filter(
    (photo) =>
      !personFilter ||
      (personFilter === "unknown"
        ? !photo.tags.some((tag) =>
            knownPeople!.has(tag.personId),
          )
        : photo.tags.some((t) => t.personId === personFilter)),
  );
  const activeMode = yearFilter
    ? "years"
    : personFilter && mode === "people"
      ? "all"
      : mode;
  const localAlbums =
    loadPage || activeMode === "all"
      ? []
      : photoAlbums(available, family.people, activeMode);
  const localAlbum = yearFilter
    ? localAlbums.find((item) => item.id === yearFilter)
    : null;
  const pageKey = JSON.stringify([
    activeMode,
    personFilter,
    yearFilter,
    dataGeneration,
  ]);
  useEffect(() => {
    if (!loadPage) return;
    let active = true;
    const request = ++pageRequest.current;
    pagePending.current = true;
    queueMicrotask(() => {
      if (active) {
        setPageLoading(true);
        setPageError("");
      }
    });
    void loadPage({
      mode: activeMode,
      personId: personFilter,
      year: yearFilter,
    })
      .then((page) => {
        if (active && request === pageRequest.current)
          setRemote({ key: pageKey, page });
      })
      .catch((error) => {
        if (active && request === pageRequest.current)
          setPageError(
            error instanceof Error
              ? error.message
              : "Не удалось загрузить фотографии",
          );
      })
      .finally(() => {
        if (active && request === pageRequest.current) {
          pagePending.current = false;
          setPageLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [
    loadPage,
    activeMode,
    personFilter,
    yearFilter,
    dataGeneration,
    pageKey,
    retry,
  ]);
  const page = remote?.key === pageKey ? remote.page : null;
  const albums = loadPage
    ? page?.albums || []
    : localAlbums.map((item) => ({
        id: item.id,
        label: item.label,
        count: item.photos.length,
        cover: item.photos[0].url,
      }));
  const album = loadPage
    ? page?.album
    : localAlbum && {
        label: localAlbum.label,
        count: localAlbum.photos.length,
      };
  const photos = loadPage
    ? page?.photos || []
    : yearFilter
      ? localAlbum?.photos || []
      : newestPhotos(available);
  const browsingAlbums = activeMode !== "all" && !yearFilter;
  async function more() {
    if (!loadPage) {
      setLimit((n) => n + 30);
      return;
    }
    if (pagePending.current || !page) return;
    const request = ++pageRequest.current;
    pagePending.current = true;
    setPageLoading(true);
    setPageError("");
    try {
      const next = await loadPage({
        mode: activeMode,
        personId: personFilter,
        year: yearFilter,
        offset: browsingAlbums ? page.albums.length : page.photos.length,
      });
      if (request !== pageRequest.current) return;
      if (next.total !== page.total || next.photoIds.length !== page.photoIds.length ||
          next.photoIds.some((id, index) => id !== page.photoIds[index]))
        throw new Error("Альбом изменился. Повторите загрузку.");
      setRemote((current) =>
        current?.key === pageKey
          ? {
              key: pageKey,
              page: {
                ...next,
                albums: [...current.page.albums, ...next.albums],
                photos: [...current.page.photos, ...next.photos],
              },
            }
          : current,
      );
    } catch (error) {
      if (request !== pageRequest.current) return;
      setPageError(
        error instanceof Error
          ? error.message
          : "Не удалось загрузить фотографии",
      );
    } finally {
      if (request === pageRequest.current) {
        pagePending.current = false;
        setPageLoading(false);
      }
    }
  }
  const filterPerson = family.people.find((p) => p.id === personFilter);
  return (
    <section className="gallery-view" aria-label="Галерея семейных фотографий">
      {dragging &&
        mayEdit &&
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
            <button
              onClick={() => {
                setMode("people");
                setLimit(30);
                onSelectAlbum(null, null);
              }}
            >
              Показать все фотографии
            </button>
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
                ...(!personFilter
                  ? [["people", "По людям", "Люди"] as const]
                  : []),
                ["years", "По годам", "Годы"],
              ] as const
            ).map(([value, label, compactLabel]) => (
              <button
                key={value}
                aria-label={label}
                aria-pressed={activeMode === value}
                onClick={() => {
                  setMode(value);
                  setLimit(30);
                  if (yearFilter)
                    onSelectAlbum(personFilter || null, null, true);
                }}
              >
                <span className="gallery-mode-label">{label}</span>
                <span className="gallery-mode-label-compact" aria-hidden="true">
                  {compactLabel}
                </span>
              </button>
            ))}
          </div>
          {mayEdit && (
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
              setMode("years");
              onSelectAlbum(personFilter || null, null, true);
              setLimit(30);
            }}
          >
            ← Все альбомы
          </button>
          <h3>
            {album.label} · {album.count}
          </h3>
        </div>
      )}
      {pageError && (
        <p role="alert" className="form-error">
          {pageError}{" "}
          <button onClick={() => setRetry((n) => n + 1)}>Повторить</button>
        </p>
      )}
      {loadPage && !page ? (
        !pageError && <p role="status">Загружаются фотографии…</p>
      ) : !(browsingAlbums ? albums.length : photos.length) ? (
        <div className="gallery-empty">
          <ImagePlus size={42} strokeWidth={1} />
          <h3>Первые страницы альбома</h3>
          <p>
            {mayEdit
              ? canEdit
                ? "Добавьте семейную фотографию и отметьте на ней людей."
                : "Добавьте семейную фотографию в архив."
              : "В архиве пока нет фотографий."}
          </p>
        </div>
      ) : browsingAlbums ? (
        <div className="photo-albums">
          {albums.slice(0, loadPage ? undefined : limit).map((item) => (
            <ArchiveLink
              key={item.id}
              href={scopedArchivePath(
                `/photos?${new URLSearchParams({
                  ...(activeMode === "people"
                    ? { personId: item.id }
                    : {
                        ...(personFilter ? { personId: personFilter } : {}),
                        year: item.id,
                      }),
                })}`,
              )}
              onNavigate={() => {
                if (activeMode === "people") {
                  setMode("all");
                  onSelectAlbum(item.id, null);
                } else {
                  onSelectAlbum(personFilter || null, item.id);
                }
                setLimit(30);
              }}
            >
              <img src={mediaPreview(item.cover)} alt="" loading="lazy" />
              <span>
                <b>{item.label}</b>
                <small>{item.count} фото</small>
              </span>
            </ArchiveLink>
          ))}
        </div>
      ) : (
        <div className="photo-grid">
          {photos.slice(0, loadPage ? undefined : limit).map((photo) => (
            <ArchiveLink
              className="photo-tile"
              key={photo.id}
              href={scopedArchivePath(
                archiveTargetPath({ kind: "photo", id: photo.id }),
              )}
              onNavigate={() =>
                onOpen(photo.id, page?.photoIds || photos.map((p) => p.id))
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
            </ArchiveLink>
          ))}
        </div>
      )}
      {(loadPage
        ? page && page.total > (browsingAlbums ? albums.length : photos.length)
        : (browsingAlbums ? albums.length : photos.length) > limit) && (
        <LoadMore onMore={() => void more()} busy={pageLoading} />
      )}
    </section>
  );
}
