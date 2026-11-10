import { useCallback, useEffect, useState } from "react";
import { fullName, years, type ArchivePhoto, type Person } from "../../domain";
import { chroniclePhotos } from "../../domain/family-chronicle";
import { photoCaption } from "../../domain/photo-metadata";
import type {
  GalleryPage,
  GalleryQuery,
} from "../../domain/archive-view-projection";
import { ChronicleStage } from "./chronicle-stage";
import { ChronicleLoading } from "./chronicle-loading";
import { ChroniclePhotoNavigation } from "./chronicle-photo-navigation";
import { useChroniclePlayback } from "./use-chronicle-playback";

function ChroniclePlayer({
  photos,
  person,
  onPerson,
}: {
  photos: ArchivePhoto[];
  person: Person;
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
  const [fallback, setFallback] = useState(false),
    [visible, setVisible] = useState(!document.hidden);
  const navigate = useCallback(
    (target: number) => {
      if (busy || target === index || target < 0 || target >= photos.length)
        return;
      setBusy(true);
      setIndex(target);
    },
    [busy, index, photos.length],
  );
  const next = useCallback(
    () => navigate((index + 1) % photos.length),
    [navigate, index, photos.length],
  );
  const previous = useCallback(
    () => navigate((index - 1 + photos.length) % photos.length),
    [navigate, index, photos.length],
  );
  const progress = useChroniclePlayback(
    photos[index].id,
    playing && photos.length > 1,
    busy || !visible,
    next,
  );
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
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("select, input, textarea"))
        return;
      if (
        event.key === "ArrowRight" ||
        (event.code === "Space" &&
          !(event.target as HTMLElement).closest("button"))
      ) {
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
  const failed = useCallback(() => setPlaying(false), []);
  const degrade = useCallback(() => setFallback(true), []);
  const shown = photos.find((photo) => photo.id === shownId)!;
  const active = photos.findIndex((photo) => photo.id === shownId);
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
      <span className="chronicle-slide-number" aria-hidden="true">
        {String(active + 1).padStart(2, "0")}
      </span>
      <span className="chronicle-slide-total" aria-hidden="true">
        {String(photos.length).padStart(2, "0")}
      </span>
      <span className="chronicle-sr-only" aria-label="Номер снимка">
        {active + 1} / {photos.length}
      </span>
      <div className="chronicle-controls">
        <button
          type="button"
          aria-label="Предыдущий снимок"
          disabled={busy || photos.length < 2}
          onClick={previous}
        >
          ←
        </button>
        <button
          type="button"
          aria-label={playing ? "Приостановить хронику" : "Продолжить хронику"}
          disabled={photos.length < 2}
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? "Пауза" : "Продолжить"}
        </button>
        <button
          type="button"
          aria-label="Следующий снимок"
          disabled={busy || photos.length < 2}
          onClick={next}
        >
          →
        </button>
        <label>
          <span className="chronicle-sr-only">Переход</span>
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
      </div>
      <div className="chronicle-caption" aria-live={playing ? "off" : "polite"}>
        <button
          type="button"
          className="chronicle-person"
          onClick={() => onPerson(person.id)}
        >
          <strong>{fullName(person)}</strong>
          <span>{years(person)}</span>
        </button>
        <p className="chronicle-date">
          {!shown.takenAt && !shown.year && "Дата не указана · "}
          {photoCaption(shown) || "Семейная фотография"}
        </p>
        {shown.description && (
          <p className="chronicle-description">{shown.description}</p>
        )}
        {fallback && (
          <small className="chronicle-fallback" role="status">
            Включён облегчённый переход
          </small>
        )}
      </div>
      <ChroniclePhotoNavigation
        photos={photos}
        active={active}
        progress={photos.length === 1 ? 100 : progress}
        busy={busy}
        onSelect={navigate}
      />
      <span className="chronicle-help">
        <span>→ — дальше · ← — назад</span>
        <span>Листайте фотографии свайпом</span>
      </span>
    </div>
  );
}

export default function FamilyChronicle({
  person,
  loadGallery,
  onPerson,
}: {
  person: Person;
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
        const page = await loadGallery({
          mode: "all",
          personId: person.id,
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
      if (!cancelled) setPhotos(chroniclePhotos(all, [person.id]));
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
  }, [person.id, loadGallery, attempt]);
  if (error)
    return (
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
    );
  if (photos === null)
    return (
      <ChronicleLoading
        label={`Собираем хронику…${loaded ? ` ${loaded} фото` : ""}`}
      />
    );
  if (!photos.length)
    return (
      <div className="chronicle-status">
        <p>Для этой хроники пока нет фотографий.</p>
        <p>Добавьте снимки в фотоальбом и отметьте на них этого человека.</p>
      </div>
    );
  return (
    <ChroniclePlayer photos={photos} person={person} onPerson={onPerson} />
  );
}
