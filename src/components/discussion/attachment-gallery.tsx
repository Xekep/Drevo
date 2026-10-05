import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import type { CommentAttachment } from "../../shared/person-discussion";
import { archiveResourceUrl, memberPreviewAt } from "../../domain/archive-context";
import { usePhotoSwipe } from "../use-photo-swipe";
import { MemberPreviewExit } from "../member-preview-exit";

function GallerySlide({
  files,
  id,
  onNavigate,
  onClose,
}: {
  files: CommentAttachment[];
  id: string;
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const index = files.findIndex((file) => file.id === id);
  const current = files[index];
  const previous = files[index - 1],
    next = files[index + 1];
  const space = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (content.current?.closest("dialog")?.open) content.current.focus();
  }, []);
  const [failed, setFailed] = useState(false);
  const swipe = usePhotoSwipe({
    previous: previous?.id,
    next: next?.id,
    locked: false,
    onNavigate,
    onTap: () => {},
  });
  return (
    <div className="discussion-gallery-content" ref={content} tabIndex={-1}>
      <header>
        <span aria-live="polite">
          {current.name} · {index + 1} / {files.length}
        </span>
        <a
          href={archiveResourceUrl(`${current.url}?download=1`)}
          download={current.name}
          aria-label="Скачать изображение"
        >
          <Download size={20} aria-hidden="true" />
        </a>
        <button
          type="button"
          aria-label="Закрыть просмотр изображений"
          onClick={onClose}
        >
          <X size={22} aria-hidden="true" />
        </button>
      </header>
      <div
        className={`discussion-gallery-space${swipe.settling ? " is-settling" : ""}`}
        ref={space}
        {...swipe.handlers}
      >
        <div
          className="discussion-gallery-track"
          style={{ transform: `translate3d(${swipe.offset}px,0,0)` }}
        >
          {previous && (
            <div className="discussion-gallery-slide is-previous">
              <img
                src={archiveResourceUrl(previous.previewUrl!)}
                alt=""
                draggable={false}
              />
            </div>
          )}
          <div className="discussion-gallery-slide photo-slide-current">
            {failed ? (
              <p role="alert">
                Не удалось загрузить изображение. Попробуйте открыть его
                повторно.
              </p>
            ) : (
              <img
                className="tag-image"
                src={archiveResourceUrl(current.url)}
                alt={current.name}
                draggable={false}
                onError={() => setFailed(true)}
              />
            )}
          </div>
          {next && (
            <div className="discussion-gallery-slide is-next">
              <img
                src={archiveResourceUrl(next.previewUrl!)}
                alt=""
                draggable={false}
              />
            </div>
          )}
        </div>
        <button
          className="discussion-gallery-previous"
          type="button"
          disabled={!previous}
          aria-label="Предыдущее изображение"
          onClick={() => swipe.navigate(-1, space.current?.clientWidth || 0)}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <button
          className="discussion-gallery-next"
          type="button"
          disabled={!next}
          aria-label="Следующее изображение"
          onClick={() => swipe.navigate(1, space.current?.clientWidth || 0)}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function AttachmentGallery({
  files,
  initialId,
  onClose,
}: {
  files: CommentAttachment[];
  initialId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState(initialId);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="discussion-lightbox"
      aria-label="Изображения сообщения"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
        ) {
          event.preventDefault();
          dialog.current
            ?.querySelector<HTMLButtonElement>(
              event.key === "ArrowLeft"
                ? ".discussion-gallery-previous"
                : ".discussion-gallery-next",
            )
            ?.click();
        }
      }}
    >
      {memberPreviewAt(window.location.pathname) && (
        <div className="discussion-gallery-preview-exit-bar">
          <MemberPreviewExit />
        </div>
      )}
      <GallerySlide
        key={id}
        files={files}
        id={id}
        onNavigate={setId}
        onClose={onClose}
      />
    </dialog>
  );
}
