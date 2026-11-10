import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { fullName, years, type ArchivePhoto, type Person } from "../../domain";
import { chroniclePhotos } from "../../domain/family-chronicle";
import { photoCaption } from "../../domain/photo-metadata";
import type {
  GalleryPage,
  GalleryQuery,
} from "../../domain/archive-view-projection";
import { ChronicleStage } from "./chronicle-stage";

function ChroniclePlayer({
  photos,
  people,
  onPerson,
}: {
  photos: ArchivePhoto[];
  people: Person[];
  onPerson: (id: string) => void;
}) {
  const [index, setIndex] = useState(0),
    [shownId, setShownId] = useState(photos[0].id);
  const [busy, setBusy] = useState(true);
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [playing, setPlaying] = useState(!reduced);
  const [effect, setEffect] = useState<"glass" | "fade">("glass");
  const [fallback, setFallback] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => {
      setReduced(preference.matches);
      if (preference.matches) setPlaying(false);
    };
    const visibility = () => setVisible(!document.hidden);
    preference.addEventListener("change", change);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      preference.removeEventListener("change", change);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const next = useCallback(() => {
    if (!busy && photos.length > 1) {
      setBusy(true);
      setIndex((value) => (value + 1) % photos.length);
    }
  }, [busy, photos.length]);
  const previous = useCallback(() => {
    if (!busy && photos.length > 1) {
      setBusy(true);
      setIndex((value) => (value - 1 + photos.length) % photos.length);
    }
  }, [busy, photos.length]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("select, input, textarea"))
        return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        previous();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [next, previous]);
  useEffect(() => {
    if (!playing || busy || !visible || photos.length < 2) return;
    const timer = setTimeout(next, 5000);
    return () => clearTimeout(timer);
  }, [playing, busy, visible, next, photos.length]);
  const failed = useCallback(() => setPlaying(false), []);
  const degrade = useCallback(() => setFallback(true), []);
  const shown = photos.find((photo) => photo.id === shownId)!;
  const names = useMemo(
    () => new Map(people.map((person) => [person.id, person])),
    [people],
  );
  const tagged = [...new Set(shown.tags.map((tag) => tag.personId))].flatMap(
    (id) => (names.has(id) ? [names.get(id)!] : []),
  );
  return (
    <div className="chronicle-player">
      <ChronicleStage
        photo={photos[index]}
        effect={fallback || !visible ? "fade" : effect}
        reduced={reduced || !visible}
        onBusy={setBusy}
        onShown={setShownId}
        onError={failed}
        onFallback={degrade}
        onNext={next}
        onPrevious={previous}
      />
      <div className="chronicle-caption" aria-live={playing ? "off" : "polite"}>
        <p className="chronicle-date">
          {!shown.takenAt && !shown.year && "Дата не указана · "}
          {photoCaption(shown) || "Семейная фотография"}
        </p>
        {shown.description && (
          <p className="chronicle-description">{shown.description}</p>
        )}
        <div className="chronicle-people">
          {tagged.map((person) => (
            <button
              type="button"
              key={person.id}
              onClick={() => onPerson(person.id)}
            >
              <strong>{fullName(person)}</strong>
              <span>{years(person)}</span>
            </button>
          ))}
        </div>
      </div>
      <footer className="chronicle-controls">
        <div className="chronicle-transport">
          <button
            type="button"
            aria-label="Предыдущий снимок"
            disabled={busy || photos.length < 2}
            onClick={previous}
          >
            <ChevronLeft size={23} />
          </button>
          <button
            type="button"
            aria-label={
              playing ? "Приостановить хронику" : "Продолжить хронику"
            }
            disabled={photos.length < 2}
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? <Pause size={23} /> : <Play size={23} />}
          </button>
          <button
            type="button"
            aria-label="Следующий снимок"
            disabled={busy || photos.length < 2}
            onClick={next}
          >
            <ChevronRight size={23} />
          </button>
          <span aria-label="Номер снимка">
            {photos.findIndex((photo) => photo.id === shownId) + 1} /{" "}
            {photos.length}
          </span>
        </div>
        <label>
          Переход{" "}
          <select
            aria-label="Переход хроники"
            value={reduced || fallback ? "fade" : effect}
            disabled={busy || reduced || fallback}
            onChange={(event) =>
              setEffect(event.target.value as "glass" | "fade")
            }
          >
            <option value="glass">Жидкое стекло</option>
            <option value="fade">Растворение</option>
          </select>
        </label>
        {fallback && <small role="status">Включён облегчённый переход</small>}
      </footer>
    </div>
  );
}

export default function FamilyChronicle({
  personIds,
  people,
  loadGallery,
  onPerson,
}: {
  personIds: string[];
  people: Person[];
  loadGallery: (query: GalleryQuery) => Promise<GalleryPage>;
  onPerson: (id: string) => void;
}) {
  const [photos, setPhotos] = useState<ArchivePhoto[] | null>(null);
  const [loaded, setLoaded] = useState(0),
    [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all: ArchivePhoto[] = [],
        seen = new Set<string>();
      let offset = 0;
      do {
        // Branches filter already authorized pages locally. personIds is an
        // internal preview field, deliberately not added as a new URL/API filter.
        const page = await loadGallery({
          mode: "all",
          ...(personIds.length === 1 ? { personId: personIds[0] } : {}),
          offset,
        });
        if (cancelled) return;
        if (offset < page.total && !page.photos.length)
          throw new Error("Неполная страница фотографий");
        for (const photo of page.photos) {
          if (seen.has(photo.id))
            throw new Error(
              "Фотографии изменились во время загрузки. Повторите открытие хроники.",
            );
          seen.add(photo.id);
          all.push(photo);
        }
        offset += page.photos.length;
        setLoaded(offset);
        if (offset >= page.total) break;
      } while (!cancelled);
      if (!cancelled) setPhotos(chroniclePhotos(all, personIds));
    })().catch((reason) => {
      if (!cancelled)
        setError(
          reason instanceof Error
            ? reason.message
            : "Не удалось загрузить хронику",
        );
    });
    return () => {
      cancelled = true;
    };
  }, [personIds, loadGallery, attempt]);
  return (
    <>
      {error ? (
        <div className="chronicle-status" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => {
              setPhotos(null);
              setError("");
              setLoaded(0);
              setAttempt((value) => value + 1);
            }}
          >
            Повторить загрузку
          </button>
        </div>
      ) : photos === null ? (
        <div className="chronicle-status" role="status">
          Собираем хронику…{loaded > 0 && ` ${loaded} фото`}
        </div>
      ) : !photos.length ? (
        <div className="chronicle-status">
          <p>Для этой хроники пока нет фотографий.</p>
          <p>
            Добавьте снимки в фотоальбом и отметьте на них людей из выбранной
            ветви.
          </p>
        </div>
      ) : (
        <ChroniclePlayer photos={photos} people={people} onPerson={onPerson} />
      )}
    </>
  );
}
