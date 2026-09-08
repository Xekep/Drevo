import { useEffect, useRef, useState, type PointerEvent } from "react";
import { suggestFaces, type FaceSuggestion } from "../vision/face-assistant";
import { ImagePlus, ScanFace } from "lucide-react";
import {
  fullName,
  type ArchivePhoto,
  type Family,
  type PhotoTag,
} from "../domain";
import { EditorDialog } from "./editor-dialog";
type Rect = Pick<PhotoTag, "x" | "y" | "width" | "height">;
export function Gallery({
  family,
  canEdit,
  busy,
  upload,
  onOpen,
  personFilter,
  onClearFilter,
}: {
  family: Family;
  canEdit: boolean;
  busy: boolean;
  upload: (file: File) => Promise<Family>;
  onOpen: (id: string) => void;
  personFilter?: string | null;
  onClearFilter: () => void;
}) {
  const [error, setError] = useState("");
  const photos = (family.photos || []).filter(
    (photo) =>
      !personFilter || photo.tags.some((t) => t.personId === personFilter),
  );
  const filterPerson = family.people.find((p) => p.id === personFilter);
  return (
    <section className="gallery-view" aria-label="Галерея семейных фотографий">
      <div className="gallery-heading">
        <div>
          <span className="section-label">СЕМЕЙНЫЙ АЛЬБОМ</span>
          <h2>
            {filterPerson
              ? `Фотоальбом: ${filterPerson.name} ${filterPerson.surname}`
              : "Лица нашей истории"}
          </h2>
          {personFilter && (
            <button onClick={onClearFilter}>Показать все фотографии</button>
          )}
          <p>
            Один снимок — несколько историй. Откройте фото, чтобы узнать людей
            на нём.
          </p>
        </div>
        {canEdit && (
          <label className={`upload-button ${busy ? "disabled" : ""}`}>
            <ImagePlus size={18} />
            {busy ? "Загружаем…" : "Добавить фото"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setError("");
                try {
                  if (file.size > 20 * 1024 * 1024)
                    throw new Error("Максимальный размер — 20 МБ");
                  const data = await upload(file);
                  onOpen(data.photos![data.photos!.length - 1].id);
                } catch (e) {
                  setError((e as Error).message);
                }
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!photos.length ? (
        <div className="gallery-empty">
          <ImagePlus size={42} strokeWidth={1} />
          <h3>Первые страницы альбома</h3>
          <p>Добавьте семейную фотографию и отметьте на ней людей.</p>
        </div>
      ) : (
        <div className="photo-grid">
          {photos.map((photo) => (
            <button
              className="photo-tile"
              key={photo.id}
              onClick={() => onOpen(photo.id)}
            >
              <img src={photo.url} alt={photo.title} loading="lazy" />
              <span>
                <b>{photo.title}</b>
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
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
export function PhotoViewer({
  photo,
  family,
  canEdit,
  canDelete,
  busy,
  save,
  onClose,
  onPerson,
}: {
  photo: ArchivePhoto;
  family: Family;
  canEdit: boolean;
  canDelete: boolean;
  busy: boolean;
  save: (f: Family) => Promise<Family>;
  onClose: () => void;
  onPerson: (id: string) => void;
}) {
  const [tagging, setTagging] = useState(false),
    [rect, setRect] = useState<Rect | null>(null),
    [personId, setPersonId] = useState(""),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const [title, setTitle] = useState(photo.title),
    [takenAt, setTakenAt] = useState(photo.takenAt || ""),
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
  async function scan() {
    if (!canEdit || scanning) return;
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
    setPersonId(s.personId || "");
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
    <EditorDialog title={photo.title} onClose={onClose} wide>
      <div className="photo-viewer">
        <div className="photo-stage">
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
              if (!start.current) return;
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
              src={photo.url}
              alt={photo.title}
              draggable={false}
              onLoad={() => {
                if (canEdit && !photo.tags.length && !scanned.current)
                  void scan();
              }}
            />
            {suggestions.map((s, i) => (
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
                <span>
                  {s.personId
                    ? `Возможно: ${family.people.find((p) => p.id === s.personId)?.name}`
                    : `Лицо ${i + 1}`}
                </span>
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
            {rect && (
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
        <aside className="photo-tools">
          <span className="section-label">ЛЮДИ НА ФОТО</span>
          {photo.tags.length === 0 && (
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
                    {s.personId
                      ? `Возможно: ${fullName(family.people.find((p) => p.id === s.personId)!)}`
                      : `Лицо ${i + 1}: выбрать человека`}
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
                      <label>
                        Кто это?
                        <select
                          value={personId}
                          onChange={(e) => setPersonId(e.target.value)}
                        >
                          <option value="">Выберите человека</option>
                          {family.people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {fullName(p)}
                            </option>
                          ))}
                        </select>
                      </label>
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
              <form
                className="archive-form photo-metadata"
                onSubmit={async (e) => {
                  e.preventDefault();
                  await update({
                    ...photo,
                    title: title.trim(),
                    takenAt: takenAt.trim() || undefined,
                    place: place.trim() || undefined,
                    year: year.trim() || undefined,
                    event: event.trim() || undefined,
                    description: description.trim() || undefined,
                  });
                }}
              >
                <label>
                  Название
                  <input
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
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
      </div>
    </EditorDialog>
  );
}
