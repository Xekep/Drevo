import { useEffect, useRef, useState, type PointerEvent } from "react";
import { suggestFaces, type FaceSuggestion } from "../vision/face-assistant";
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
import { mediaPreview } from "../domain/media-preview";
type Rect = Pick<PhotoTag, "x" | "y" | "width" | "height">;
export function PhotoViewer({
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
  initialEditing = false,
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
  initialEditing?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const swipe = useRef<{ x: number; y: number; time: number } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const index = photos.findIndex((p) => p.id === photo.id);
  const previous = photos[index - 1];
  const next = photos[index + 1];
  const [editing, setEditing] = useState(initialEditing);
  const [showTags, setShowTags] = useState(false);
  const canEdit = allowedEdit && editing;
  const navigationLocked = canEdit || busy;
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
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
  function navigate(direction: -1 | 1) {
    const target = direction < 0 ? previous : next;
    if (target && !navigationLocked) onNavigate(target.id);
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
  useEffect(() => () => scanController.current?.abort(), []);
  async function scan(enterEditing = false) {
    if (!(canEdit || (enterEditing && allowedEdit)) || scanning) return;
    scanned.current = true;
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    setScanStatus("Загружаем модель поиска лиц…");
    try {
      const found = await suggestFaces(photo, controller.signal, setScanStatus);
      if (!controller.signal.aborted) {
        setSuggestions(found);
        setScanStatus(
          found.length
            ? `Найдено лиц: ${found.length}. Подтвердите предложенные отметки.`
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
  }
  function selectSuggestion(s: FaceSuggestion) {
    setRect(s.box);
    setPersonId("");
    setSuggestionId(s.id);
    setTagging(true);
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
    <dialog
      ref={dialog}
      className="photo-lightbox"
      aria-label={`Просмотр фото: ${photoLabel(photo)}`}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (
          navigationLocked ||
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
          navigate(e.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <button
        className="photo-close"
        onClick={onClose}
        aria-label="Закрыть просмотр фото"
        title="Закрыть · Esc"
      >
        <X size={22} />
      </button>
      <div
        className={`photo-viewer ${canEdit ? "is-editing" : "is-viewing"} ${showTags ? "show-tags" : ""} ${infoOpen ? "info-open" : ""}`}
      >
        <div
          className="photo-stage"
          onTouchStart={(e) => {
            swipe.current = null;
            if (
              navigationLocked ||
              e.touches.length !== 1 ||
              (e.target instanceof HTMLElement && e.target.closest("button, a"))
            )
              return;
            swipe.current = {
              x: e.touches[0].clientX,
              y: e.touches[0].clientY,
              time: Date.now(),
            };
          }}
          onTouchEnd={(e) => {
            const from = swipe.current;
            swipe.current = null;
            if (!from || e.touches.length || !e.changedTouches.length) return;
            const dx = e.changedTouches[0].clientX - from.x;
            const dy = e.changedTouches[0].clientY - from.y;
            if (
              Date.now() - from.time < 800 &&
              Math.abs(dx) > 55 &&
              Math.abs(dx) > Math.abs(dy) * 2
            )
              navigate(dx < 0 ? 1 : -1);
          }}
          onTouchCancel={() => {
            swipe.current = null;
          }}
        >
          <div className="photo-image-space">
            <div
              ref={area}
              className={`tag-image ${tagging ? "tagging" : ""}`}
              role="group"
              aria-label="Фотография с отметками людей"
              onPointerDown={(e) => {
                if (!tagging || e.button !== 0) return;
                e.preventDefault();
                start.current = point(e);
                setRect(null);
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
                src={mediaPreview(photo.url, "display")}
                alt={photoLabel(photo)}
                draggable={false}
                onLoad={() => {
                  if (canEdit && !photo.tags.length && !scanned.current)
                    void scan();
                }}
              />
              {canEdit &&
                suggestions.map((s, i) => (
                  <button
                    key={s.id}
                    className="photo-tag suggested-tag"
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
                const person = family.people.find((p) => p.id === tag.personId);
                return (
                  person && (
                    <button
                      key={tag.id}
                      className="photo-tag"
                      disabled={tagging}
                      style={{
                        left: `${tag.x * 100}%`,
                        top: `${tag.y * 100}%`,
                        width: `${tag.width * 100}%`,
                        height: `${tag.height * 100}%`,
                      }}
                      onClick={() => onPerson(person.id)}
                      aria-label={`Открыть карточку: ${fullName(person)}`}
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
            <a className="photo-original" href={photo.url} download>
              <Download size={16} />
              Скачать оригинал
            </a>
            <button
              className="photo-info-toggle"
              aria-expanded={infoOpen}
              aria-controls="photo-information"
              onClick={() => setInfoOpen(!infoOpen)}
            >
              <Info size={18} />О снимке
            </button>
          </footer>
        </div>
        <aside
          className="photo-tools"
          id="photo-information"
          aria-label="Сведения о снимке"
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
          {allowedEdit && (
            <button
              className="photo-edit-toggle"
              aria-pressed={editing}
              disabled={busy}
              onClick={() => {
                setEditing(!editing);
                if (editing) {
                  setConfirm(false);
                  setTagging(false);
                  setRect(null);
                  scanController.current?.abort();
                  setScanning(false);
                } else if (!photo.tags.length && !scanned.current)
                  void scan(true);
              }}
            >
              {editing ? <Check size={16} /> : <Pencil size={16} />}
              {editing ? "Завершить редактирование" : "Редактировать"}
            </button>
          )}
          {(canEdit || photo.tags.length > 0) && (
            <span className="section-label">ЛЮДИ НА ФОТО</span>
          )}
          {canEdit && photo.tags.length === 0 && (
            <p>На этом снимке пока никто не отмечен.</p>
          )}
          {photo.tags.map((tag) => (
            <div key={tag.id} className="connection-row">
              <button onClick={() => onPerson(tag.personId)}>
                {fullName(family.people.find((p) => p.id === tag.personId)!)}
              </button>
              {canEdit && (
                <button
                  disabled={busy}
                  aria-label="Убрать отметку"
                  onClick={() =>
                    void update({
                      ...photo,
                      tags: photo.tags.filter((t) => t.id !== tag.id),
                    })
                  }
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <>
              <p className="field-hint">
                Выберите рамку и найдите человека по ФИО.
              </p>
              <button disabled={scanning} onClick={() => void scan()}>
                {scanning ? "Ищем лица…" : "Найти лица"}
              </button>
              {scanStatus && <p role="status">{scanStatus}</p>}
              {scanning && (
                <button
                  onClick={() => {
                    scanController.current?.abort();
                    setScanning(false);
                    setScanStatus("Поиск остановлен. Можно отметить вручную.");
                  }}
                >
                  Остановить поиск
                </button>
              )}
              {suggestions.map((s, i) => (
                <div key={s.id} className="connection-row">
                  <button onClick={() => selectSuggestion(s)}>
                    {`Лицо ${i + 1}: выбрать человека`}
                  </button>
                  <button
                    aria-label="Убрать предложение"
                    onClick={() => {
                      setSuggestions((list) =>
                        list.filter((x) => x.id !== s.id),
                      );
                      if (suggestionId === s.id) {
                        setRect(null);
                        setSuggestionId(null);
                      }
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="primary-action"
                onClick={() => {
                  setTagging(!tagging);
                  setRect(null);
                  setSuggestionId(null);
                }}
              >
                <ScanFace size={16} />
                {tagging ? "Завершить разметку" : "Отметить человека"}
              </button>
              {tagging && (
                <div className="archive-form">
                  <p>
                    Обведите человека на фото. Или создайте рамку кнопкой и
                    настройте её ниже.
                  </p>
                  <button
                    onClick={() =>
                      setRect({ x: 0.35, y: 0.2, width: 0.3, height: 0.4 })
                    }
                  >
                    Создать рамку
                  </button>
                  {rect && (
                    <>
                      <details className="tag-adjustments">
                        <summary>Уточнить рамку</summary>
                        {(["x", "y", "width", "height"] as const).map(
                          (key, i) => (
                            <label key={key}>
                              {["Слева", "Сверху", "Ширина", "Высота"][i]}
                              <input
                                type="range"
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
                      <PersonSearch
                        value={personId}
                        selected={family.people.find((p) => p.id === personId)}
                        onChange={setPersonId}
                        disabled={busy}
                      />
                      <button
                        disabled={!personId || busy}
                        onClick={async () => {
                          if (
                            await update({
                              ...photo,
                              tags: [
                                ...photo.tags,
                                { ...rect, id: crypto.randomUUID(), personId },
                              ],
                            })
                          ) {
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
              <details className="photo-description-editor">
                <summary>Изменить описание фотографии</summary>
                <form
                  className="archive-form photo-metadata"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await update({
                      ...photo,
                      takenAt: takenAt.trim() || undefined,
                      place: place.trim() || undefined,
                      year: year.trim() || undefined,
                      event: event.trim() || undefined,
                      description: description.trim() || undefined,
                    });
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
                  <label>
                    Место
                    <input
                      value={place}
                      placeholder="Город, деревня или адрес"
                      onChange={(e) => setPlace(e.target.value)}
                    />
                  </label>
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
              {canDelete && (
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
          {
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
          }
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </aside>
      </div>
    </dialog>
  );
}
