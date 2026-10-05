import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  faceRecognitionAvailable,
  saveFaceDescriptor,
  suggestFaces,
  type FaceSuggestion,
} from "../vision/face-assistant";
import {
  ScanFace,
  Pencil,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
  X,
} from "lucide-react";
import {
  fullName,
  type ArchivePhoto,
  type Family,
  type PhotoTag,
} from "../domain";
import { photoLabel } from "../domain/photo-metadata";
import { PersonSearch } from "./person-search";
import { usePhotoSwipe } from "./use-photo-swipe";
import { useDockSwipe } from "../hooks/useDockSwipe";
import { mediaPreview } from "../domain/media-preview";
import { MemberPreviewExit } from "./member-preview-exit";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import { PlaceField } from "./place-field";
import { CopyArchiveLink } from "./copy-archive-link";
import { PhotoPersonSidebar } from "./photo-person-sidebar";
import {
  confirmDiscardChanges,
  useUnsavedChanges,
} from "../hooks/useUnsavedChanges";
type Rect = Pick<PhotoTag, "x" | "y" | "width" | "height">;
function PhotoViewerContent({
  photo,
  photos,
  onNavigate,
  family,
  canEdit: allowedEdit,
  canDelete,
  busy,
  save,
  onClose,
  onPerson,
  currentUserPersonId,
  canLoadDocuments,
  initialEditing = false,
  onDirtyChange,
}: {
  photo: ArchivePhoto;
  photos: ArchivePhoto[];
  onNavigate: (id: string) => void;
  family: Family;
  canEdit: boolean;
  canDelete: boolean;
  busy: boolean;
  save: (f: Family) => Promise<Family>;
  onClose: () => void;
  onPerson: (id: string) => void;
  currentUserPersonId?: string;
  canLoadDocuments: boolean;
  initialEditing?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const [viewedPersonId, setViewedPersonId] = useState<string | null>(null);
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [imageAttempt, setImageAttempt] = useState(0);
  const [loadingVisible, setLoadingVisible] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const displaySrc = mediaPreview(photo.url, "display");
  useLayoutEffect(() => {
    const node = image.current;
    // Cached adjacent slides may already be ready before their load event.
    setImageState(
      node?.complete ? (node.naturalWidth ? "ready" : "error") : "loading",
    );
    setLoadingVisible(false);
  }, [displaySrc, imageAttempt]);
  useEffect(() => {
    if (imageState !== "loading") return;
    const timer = window.setTimeout(() => {
      const node = image.current;
      if (node?.complete)
        setImageState(node.naturalWidth ? "ready" : "error");
      else setLoadingVisible(true);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [imageState, displaySrc, imageAttempt]);
  const index = photos.findIndex((p) => p.id === photo.id);
  const previous = photos[index - 1];
  const next = photos[index + 1];
  const [editing, setEditing] = useState(initialEditing);
  const [faceAccess, setFaceAccess] = useState(false);
  useEffect(() => {
    if (!allowedEdit) return;
    const controller = new AbortController();
    void faceRecognitionAvailable(controller.signal)
      .then((enabled) => {
        if (!controller.signal.aborted) setFaceAccess(enabled);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [allowedEdit]);
  const [showTags, setShowTags] = useState(false);
  const [highlightedPerson, setHighlightedPerson] = useState<string | null>(
    null,
  );
  const taggedPeople = [
    ...new Set(photo.tags.map((tag) => tag.personId)),
  ].flatMap((id) => {
    const person = family.people.find((p) => p.id === id);
    return person ? [person] : [];
  });
  const viewedPerson = family.people.find(
    (person) => person.id === viewedPersonId,
  );
  function previewPerson(id: string) {
    setViewedPersonId(id);
    setInfoOpen(true);
    setShowTags(true);
    setHighlightedPerson(id);
  }
  const canEdit = allowedEdit && editing;
  const navigationLocked = canEdit || busy;
  const photoTools = useRef<HTMLElement>(null);
  const dismissOverlay = () => {
    if (viewedPersonId) {
      setViewedPersonId(null);
      setHighlightedPerson(null);
    } else setInfoOpen(false);
  };
  useDockSwipe(
    photoTools,
    photoTools,
    true,
    infoOpen && !canEdit && !viewedPerson,
    dismissOverlay,
    () => {},
    true,
  );
  useEffect(() => {
    // Only the two adjacent display previews; original files remain on demand.
    for (const neighbor of [previous, next]) {
      if (neighbor) {
        const image = new Image();
        const src = mediaPreview(neighbor.url, "display");
        if (src) image.src = src;
      }
    }
  }, [previous, next]);
  const imageSpace = useRef<HTMLDivElement>(null);
  const slide = usePhotoSwipe({
    previous: previous?.id,
    next: next?.id,
    locked: navigationLocked,
    onNavigate,
    onTap: () => setShowTags((value) => !value),
    onDismiss:
      (infoOpen || !!viewedPerson) && !canEdit ? dismissOverlay : undefined,
  });
  function navigate(direction: -1 | 1) {
    slide.navigate(direction, imageSpace.current?.clientWidth || 0);
  }
  const [requestedTagging, setTagging] = useState(false),
    [rect, setRect] = useState<Rect | null>(null),
    [personId, setPersonId] = useState(""),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const tagging = canEdit && requestedTagging;
  const [takenAt, setTakenAt] = useState(photo.takenAt || ""),
    [place, setPlace] = useState(photo.place || ""),
    [year, setYear] = useState(photo.year || ""),
    [event, setEvent] = useState(photo.event || ""),
    [description, setDescription] = useState(photo.description || "");
  const area = useRef<HTMLDivElement>(null),
    start = useRef<{ x: number; y: number } | null>(null);
  const [suggestions, setSuggestions] = useState<FaceSuggestion[]>([]),
    [scanning, setScanning] = useState(false),
    [scanStatus, setScanStatus] = useState(""),
    [suggestionId, setSuggestionId] = useState<string | null>(null);
  const scanned = useRef(false),
    scanController = useRef<AbortController | null>(null);
  const dirty =
    takenAt !== (photo.takenAt || "") ||
    place !== (photo.place || "") ||
    year !== (photo.year || "") ||
    event !== (photo.event || "") ||
    description !== (photo.description || "") ||
    !!rect;
  useUnsavedChanges(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => scanController.current?.abort(), []);
  const scan = useCallback(async (enterEditing = false) => {
    if (!(canEdit || (enterEditing && allowedEdit)) || scanning || !faceAccess)
      return;
    if (!(await faceRecognitionAvailable())) {
      setFaceAccess(false);
      return;
    }
    scanned.current = true;
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    setScanStatus("Загружаем модель поиска лиц…");
    try {
      const found = await suggestFaces(photo, controller.signal, (status) => {
        if (!controller.signal.aborted) setScanStatus(status);
      });
      if (!controller.signal.aborted) {
        setSuggestions(found);
        setScanStatus(
          found.length
            ? `Найдено лиц: ${found.length}. Выберите, кого отметить.`
            : "Новых лиц не найдено. Можно отметить человека вручную.",
        );
      }
    } catch {
      if (!controller.signal.aborted)
        setScanStatus(
          "Автопоиск недоступен. Попробуйте ещё раз или отметьте лица вручную.",
        );
    } finally {
      if (!controller.signal.aborted) setScanning(false);
    }
  }, [allowedEdit, canEdit, faceAccess, photo, scanning]);
  useEffect(() => {
    if (
      canEdit &&
      faceAccess &&
      imageState === "ready" &&
      !photo.tags.length &&
      !scanned.current
    )
      void scan();
  }, [canEdit, faceAccess, imageState, photo.tags.length, scan]);
  function selectSuggestion(s: FaceSuggestion) {
    if (busy) return;
    setRect(s.box);
    setPersonId(s.match?.personId || "");
    setSuggestionId(s.id);
    setTagging(true);
    setInfoOpen(true);
    photoTools.current?.scrollTo(0, 0);
  }
  function cancelTagging() {
    setTagging(false);
    setRect(null);
    setPersonId("");
    setSuggestionId(null);
  }
  function point(e: PointerEvent) {
    const b = area.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)),
      y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)),
    };
  }
  async function update(next: ArchivePhoto) {
    setError("");
    try {
      await save({
        ...family,
        photos: family.photos!.map((p) => (p.id === photo.id ? next : p)),
      });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  return (
    <div className="photo-lightbox-content">
      <div
        className="photo-toolbar"
        role="group"
        aria-label="Действия с фотографией"
      >
        {allowedEdit && !viewedPerson && (
          <button
            className="photo-edit-toggle"
            aria-pressed={editing}
            aria-label={editing ? "Завершить редактирование" : "Редактировать"}
            disabled={busy || slide.settling}
            onClick={() => {
              if (editing && !confirmDiscardChanges(dirty)) return;
              setEditing(!editing);
              if (editing) {
                setTakenAt(photo.takenAt || "");
                setPlace(photo.place || "");
                setYear(photo.year || "");
                setEvent(photo.event || "");
                setDescription(photo.description || "");
                setConfirm(false);
                setTagging(false);
                setRect(null);
                setPersonId("");
                setSuggestionId(null);
                scanController.current?.abort();
                setScanning(false);
              } else if (!photo.tags.length && !scanned.current)
                void scan(true);
            }}
          >
            {editing ? <Check size={16} /> : <Pencil size={16} />}
            {editing ? "Готово" : "Редактировать"}
          </button>
        )}
        <CopyArchiveLink
          className="photo-copy-link"
          target={{ kind: "photo", id: photo.id }}
        />
        <button
          className="photo-close"
          onClick={onClose}
          aria-label="Закрыть просмотр фото"
          title="Закрыть · Esc"
        >
          <X size={22} />
        </button>
        <MemberPreviewExit />
      </div>
      <div
        className={`photo-viewer ${canEdit ? "is-editing" : "is-viewing"} ${showTags ? "show-tags" : ""} ${infoOpen ? "info-open" : ""} ${viewedPerson ? "person-open" : ""}`}
      >
        <div className="photo-stage">
          <div
            ref={imageSpace}
            className="photo-image-space"
            {...slide.handlers}
          >
            <div
              className={`photo-slide-track ${slide.settling ? "is-settling" : ""}`}
              style={{ transform: `translate3d(${slide.offset}px, 0, 0)` }}
            >
              {[previous, next].map(
                (neighbor, i) =>
                  neighbor && (
                    <div
                      key={i}
                      className={`photo-slide-neighbor ${i === 0 ? "is-previous" : "is-next"}`}
                      aria-hidden="true"
                    >
                      <img
                        src={mediaPreview(neighbor.url, "display")}
                        alt=""
                        draggable={false}
                      />
                    </div>
                  ),
              )}
              <div className="photo-slide-current">
                <div
                  ref={area}
                  className={`tag-image ${tagging ? "tagging" : ""}`}
                  role="group"
                  aria-label="Фотография с отметками людей"
                  onPointerDown={(e) => {
                    if (!tagging || busy || e.button !== 0) return;
                    e.preventDefault();
                    start.current = point(e);
                    setRect(null);
                    setSuggestionId(null);
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!tagging || !start.current) return;
                    const p = point(e),
                      s = start.current;
                    setRect({
                      x: Math.min(p.x, s.x),
                      y: Math.min(p.y, s.y),
                      width: Math.abs(p.x - s.x),
                      height: Math.abs(p.y - s.y),
                    });
                  }}
                  onPointerUp={(e) => {
                    if (!start.current) return;
                    start.current = null;
                    e.currentTarget.releasePointerCapture(e.pointerId);
                    if (!rect || rect.width < 0.015 || rect.height < 0.015)
                      setRect(null);
                  }}
                  onPointerCancel={() => {
                    start.current = null;
                    setRect(null);
                  }}
                >
                  <img
                    key={`${displaySrc}:${imageAttempt}`}
                    ref={image}
                    src={displaySrc}
                    alt={photoLabel(photo)}
                    draggable={false}
                    onLoad={() => {
                      setImageState("ready");
                    }}
                    onError={() => setImageState("error")}
                  />
                  {(imageState === "error" ||
                    (imageState === "loading" && loadingVisible)) && (
                    <div className="photo-load-status" role="status">
                      {imageState === "loading" ? (
                        "Загружаем фотографию…"
                      ) : (
                        <>
                          Не удалось загрузить снимок.
                          <button
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => {
                              setImageState("loading");
                              setImageAttempt((n) => n + 1);
                            }}
                          >
                            Повторить
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {canEdit &&
                    suggestions.map((s, i) => (
                      <button
                        key={s.id}
                        className={`photo-tag suggested-tag ${suggestionId === s.id ? "is-selected" : ""}`}
                        disabled={busy}
                        style={{
                          left: `${s.box.x * 100}%`,
                          top: `${s.box.y * 100}%`,
                          width: `${s.box.width * 100}%`,
                          height: `${s.box.height * 100}%`,
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => selectSuggestion(s)}
                        aria-label={`Подтвердить лицо ${i + 1}`}
                      >
                        <span>{`Лицо ${i + 1}`}</span>
                      </button>
                    ))}
                  {photo.tags.map((tag) => {
                    const person = family.people.find(
                      (p) => p.id === tag.personId,
                    );
                    return (
                      person && (
                        <button
                          key={tag.id}
                          className={`photo-tag ${highlightedPerson === tag.personId ? "is-highlighted" : ""}`}
                          disabled={tagging}
                          style={{
                            left: `${tag.x * 100}%`,
                            top: `${tag.y * 100}%`,
                            width: `${tag.width * 100}%`,
                            height: `${tag.height * 100}%`,
                          }}
                          onClick={() => previewPerson(person.id)}
                          onDoubleClick={() => onPerson(person.id)}
                          aria-label={`Показать сведения: ${fullName(person)}`}
                          title="Двойной клик — перейти к человеку в древе"
                        >
                          <span>
                            {person.name} {person.surname}
                          </span>
                        </button>
                      )
                    );
                  })}
                  {canEdit && rect && (
                    <span
                      className="photo-tag draft-tag"
                      style={{
                        left: `${rect.x * 100}%`,
                        top: `${rect.y * 100}%`,
                        width: `${rect.width * 100}%`,
                        height: `${rect.height * 100}%`,
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
          {photos.length > 1 && (
            <nav
              className="photo-navigation"
              aria-label="Переключение фотографий"
            >
              <button
                className="photo-previous"
                disabled={!previous || navigationLocked}
                onClick={() => navigate(-1)}
                aria-label="Предыдущая фотография"
                title={
                  navigationLocked
                    ? "Завершите редактирование для переключения"
                    : "Предыдущая · ←"
                }
              >
                <ChevronLeft size={30} />
              </button>
              <button
                className="photo-next"
                disabled={!next || navigationLocked}
                onClick={() => navigate(1)}
                aria-label="Следующая фотография"
                title={
                  navigationLocked
                    ? "Завершите редактирование для переключения"
                    : "Следующая · →"
                }
              >
                <ChevronRight size={30} />
              </button>
            </nav>
          )}
          <footer className="photo-footer">
            <span className="photo-counter" role="status" aria-live="polite">
              {index + 1} / {photos.length}
            </span>
            <a className="photo-original" href={archiveResourceUrl(photo.url)} download>
              <Download size={16} />
              Скачать оригинал
            </a>
            {!viewedPerson && (
              <button
                className="photo-info-toggle"
                aria-expanded={infoOpen}
                aria-controls="photo-information"
                onClick={() => setInfoOpen(!infoOpen)}
              >
                <Info size={18} />О снимке
              </button>
            )}
          </footer>
        </div>
        <aside
          ref={photoTools}
          className="photo-tools"
          id="photo-information"
          aria-label="Сведения о снимке"
          hidden={!!viewedPerson}
        >
          <button
            className="photo-info-close"
            onClick={() => setInfoOpen(false)}
            aria-label="Скрыть сведения о снимке"
          >
            <X size={20} />
          </button>
          {!canEdit && photo.tags.length > 0 && (
            <button
              className="photo-tags-toggle"
              aria-pressed={showTags}
              onClick={() => setShowTags(!showTags)}
            >
              {showTags ? "Скрыть отметки" : "Показать отметки"}
            </button>
          )}
          {!tagging && (canEdit || photo.tags.length > 0) && (
            <span className="section-label">ЛЮДИ НА ФОТО</span>
          )}
          {canEdit && !tagging && photo.tags.length === 0 && (
            <p>На этом снимке пока никто не отмечен.</p>
          )}
          {!tagging && taggedPeople.length > 0 && (
            <p className="photo-people-names">
              {taggedPeople.map((person, index) => (
                <span key={person.id}>
                  {index > 0 && ", "}
                  <button
                    className="photo-person-name"
                    onMouseEnter={() => setHighlightedPerson(person.id)}
                    onMouseLeave={() => setHighlightedPerson(null)}
                    onFocus={() => setHighlightedPerson(person.id)}
                    onBlur={() => setHighlightedPerson(null)}
                    onClick={() => previewPerson(person.id)}
                    onDoubleClick={() => onPerson(person.id)}
                    title="Двойной клик — перейти к человеку в древе"
                  >
                    {fullName(person)}
                  </button>
                  {canEdit && (
                    <button
                      className="photo-person-remove"
                      disabled={busy}
                      aria-label={`Убрать отметки: ${fullName(person)}`}
                      onClick={() =>
                        void update({
                          ...photo,
                          tags: photo.tags.filter(
                            (tag) => tag.personId !== person.id,
                          ),
                        })
                      }
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </p>
          )}
          {canEdit && (
            <>
              {!tagging && (
                <section
                  className="photo-tagging-tools"
                  aria-label="Отметить людей"
                >
                  <div className="photo-tagging-actions">
                    {faceAccess && (
                      <button
                        disabled={busy || scanning || imageState !== "ready"}
                        onClick={() => void scan()}
                      >
                        <ScanFace size={16} />
                        {scanning ? "Ищем лица…" : "Найти лица"}
                      </button>
                    )}
                    <button
                      disabled={busy || imageState !== "ready"}
                      onClick={() => {
                        setTagging(true);
                        setRect({ x: 0.35, y: 0.2, width: 0.3, height: 0.4 });
                        setPersonId("");
                        setSuggestionId(null);
                        photoTools.current?.scrollTo(0, 0);
                      }}
                    >
                      <Pencil size={15} /> Отметить вручную
                    </button>
                  </div>
                  {scanStatus && (
                    <p className="photo-scan-status" role="status">
                      {scanStatus}
                    </p>
                  )}
                  {scanning && (
                    <button
                      className="photo-scan-stop"
                      onClick={() => {
                        scanController.current?.abort();
                        setScanning(false);
                        setScanStatus(
                          "Поиск остановлен. Можно отметить вручную.",
                        );
                      }}
                    >
                      Остановить поиск
                    </button>
                  )}
                  {suggestions.length > 0 && (
                    <div
                      className="photo-face-list"
                      aria-label="Найденные лица"
                    >
                      {suggestions.map((s, i) => {
                        const match = family.people.find(
                          (p) => p.id === s.match?.personId,
                        );
                        return (
                          <div key={s.id} className="photo-face-row">
                            <button
                              disabled={busy}
                              onClick={() => selectSuggestion(s)}
                            >
                              <span className="photo-face-number">{i + 1}</span>
                              <span>
                                <b>{`Лицо ${i + 1}`}</b>
                                <small>
                                  {match
                                    ? `Возможно, ${fullName(match)}`
                                    : "Выбрать человека"}
                                </small>
                              </span>
                              <ChevronRight size={15} />
                            </button>
                            <button
                              disabled={busy}
                              aria-label={`Убрать предложение: лицо ${i + 1}`}
                              onClick={() =>
                                setSuggestions((list) =>
                                  list.filter((x) => x.id !== s.id),
                                )
                              }
                            >
                              <X size={15} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
              {tagging && (
                <div className="archive-form photo-tag-editor">
                  <div className="photo-tag-editor-heading">
                    <b>{suggestionId ? "Кто на фото?" : "Отметить человека"}</b>
                    <button
                      disabled={busy}
                      onClick={cancelTagging}
                      aria-label="Отменить отметку"
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <p className="field-hint">
                    {rect
                      ? "Выберите человека для выделенной рамки."
                      : "Обведите человека на фото или создайте рамку."}
                  </p>
                  {!rect && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        setRect({ x: 0.35, y: 0.2, width: 0.3, height: 0.4 })
                      }
                    >
                      Создать рамку
                    </button>
                  )}
                  {rect && (
                    <>
                      <PersonSearch
                        key={suggestionId || "manual"}
                        value={personId}
                        selected={family.people.find((p) => p.id === personId)}
                        onChange={setPersonId}
                        disabled={busy}
                      />
                      <details className="tag-adjustments">
                        <summary>Уточнить рамку</summary>
                        <p className="field-hint">
                          Обведите лицо на снимке или сдвиньте границы
                          ползунками.
                        </p>
                        {(["x", "y", "width", "height"] as const).map(
                          (key, i) => (
                            <label key={key}>
                              {["Слева", "Сверху", "Ширина", "Высота"][i]}
                              <input
                                type="range"
                                disabled={busy}
                                min={
                                  key === "width" || key === "height" ? 0.02 : 0
                                }
                                max={
                                  key === "x"
                                    ? 1 - rect.width
                                    : key === "y"
                                      ? 1 - rect.height
                                      : key === "width"
                                        ? 1 - rect.x
                                        : 1 - rect.y
                                }
                                step="0.005"
                                value={rect[key]}
                                onChange={(e) =>
                                  setRect({
                                    ...rect,
                                    [key]: Number(e.target.value),
                                  })
                                }
                              />
                            </label>
                          ),
                        )}
                      </details>
                      <button
                        className="primary-action"
                        disabled={!personId || busy}
                        onClick={async () => {
                          const tagId = crypto.randomUUID();
                          if (
                            await update({
                              ...photo,
                              tags: [
                                ...photo.tags,
                                {
                                  ...rect,
                                  id: tagId,
                                  personId,
                                },
                              ],
                            })
                          ) {
                            const sample = suggestionId
                              ? suggestions.find((s) => s.id === suggestionId)
                              : undefined;
                            if (sample)
                              try {
                                await saveFaceDescriptor(
                                  personId,
                                  sample.descriptor,
                                  photo.id,
                                  tagId,
                                );
                              } catch {
                                setScanStatus(
                                  "Отметка сохранена, но отпечаток лица не удалось запомнить.",
                                );
                              }
                            setRect(null);
                            setPersonId("");
                            setTagging(false);
                            if (suggestionId)
                              setSuggestions((list) =>
                                list.filter((s) => s.id !== suggestionId),
                              );
                            setSuggestionId(null);
                          }
                        }}
                      >
                        Сохранить отметку
                      </button>
                    </>
                  )}
                </div>
              )}
              {!tagging && (
                <details className="photo-description-editor">
                  <summary>Изменить описание фотографии</summary>
                  <form
                    className="archive-form photo-metadata"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const saved = await update({
                        ...photo,
                        takenAt: takenAt.trim() || undefined,
                        place: place.trim() || undefined,
                        year: year.trim() || undefined,
                        event: event.trim() || undefined,
                        description: description.trim() || undefined,
                      });
                      if (saved) {
                        setTakenAt(takenAt.trim());
                        setPlace(place.trim());
                        setYear(year.trim());
                        setEvent(event.trim());
                        setDescription(description.trim());
                      }
                    }}
                  >
                    <label>
                      Год
                      <input
                        value={year}
                        inputMode="numeric"
                        pattern="[0-9]{4}"
                        maxLength={4}
                        placeholder="1965"
                        onChange={(e) => setYear(e.target.value)}
                      />
                    </label>
                    <PlaceField
                      label="Место"
                      value={place}
                      onChange={setPlace}
                    />
                    <label>
                      Событие
                      <input
                        value={event}
                        placeholder="Свадьба, день рождения, семейная встреча"
                        onChange={(e) => setEvent(e.target.value)}
                      />
                    </label>
                    <label>
                      Дата или период (уточнение)
                      <input
                        value={takenAt}
                        placeholder="Например, лето 1965"
                        onChange={(e) => setTakenAt(e.target.value)}
                      />
                    </label>
                    <label>
                      История снимка
                      <textarea
                        rows={3}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </label>
                    <button disabled={busy}>Сохранить описание</button>
                  </form>
                </details>
              )}
              {!tagging && canDelete && (
                <button
                  className="danger-action"
                  disabled={busy}
                  onClick={async () => {
                    if (!confirm) {
                      setConfirm(true);
                      return;
                    }
                    try {
                      await save({
                        ...family,
                        photos: family.photos!.filter((p) => p.id !== photo.id),
                      });
                      onDirtyChange?.(false);
                      onClose();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  {confirm
                    ? "Подтвердить удаление из галереи"
                    : "Удалить из галереи"}
                </button>
              )}
            </>
          )}
          {!canEdit && (
            <div className="photo-details">
              {[
                ["Год", photo.year],
                ["Место", photo.place],
                ["Событие", photo.event],
                ["Дата или период", photo.takenAt],
              ]
                .filter(([, value]) => value?.trim())
                .map(([label, value]) => (
                  <p key={label}>
                    <b>{label}: </b>
                    {value}
                  </p>
                ))}
              {photo.description?.trim() && <p>{photo.description}</p>}
            </div>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </aside>
        {viewedPerson && (
          <PhotoPersonSidebar
            person={viewedPerson}
            family={family}
            isCurrentUser={currentUserPersonId === viewedPerson.id}
            canLoadDocuments={canLoadDocuments}
            onSelect={previewPerson}
            onTree={onPerson}
            onBack={() => {
              setViewedPersonId(null);
              setHighlightedPerson(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

type PhotoViewerProps = Omit<
  Parameters<typeof PhotoViewerContent>[0],
  "onDirtyChange"
> & { onDirtyChange?: (dirty: boolean) => void };
export function PhotoViewer(props: PhotoViewerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = useRef(false);
  const setDirty = (value: boolean) => {
    dirty.current = value;
    props.onDirtyChange?.(value);
  };
  const close = () => {
    if (!props.busy && confirmDiscardChanges(dirty.current)) props.onClose();
  };
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="photo-lightbox"
      aria-label={`Просмотр фото: ${photoLabel(props.photo)}`}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (
          e.altKey ||
          e.ctrlKey ||
          e.metaKey ||
          e.shiftKey ||
          (e.target instanceof HTMLElement &&
            e.target.closest("input, textarea, select, [contenteditable=true]"))
        )
          return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          dialog.current
            ?.querySelector<HTMLButtonElement>(
              e.key === "ArrowLeft" ? ".photo-previous" : ".photo-next",
            )
            ?.click();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <PhotoViewerContent
        key={props.photo.id}
        {...props}
        onClose={close}
        onPerson={(id) => {
          if (!props.busy && confirmDiscardChanges(dirty.current))
            props.onPerson(id);
        }}
        onDirtyChange={setDirty}
      />
    </dialog>
  );
}
