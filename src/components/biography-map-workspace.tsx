import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { BiographyMap } from "../domain/biography-map";
import { ChevronDown, Search, X } from "lucide-react";
import "../styles/biography-map.css";
const Surface = lazy(() => import("./biography-map-surface"));
const searchText = (text: string) => text.toLocaleLowerCase("ru").replace(/ё/g, "е");

export default function BiographyMapWorkspace({
  data,
  onClose,
  returnLabel = "Вернуться к древу",
}: {
  data: BiographyMap;
  onClose: () => void;
  returnLabel?: string;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const [pointsOpen, setPointsOpen] = useState(false);
  const [search, setSearch] = useState({ data, text: "" });
  const query = search.data === data ? search.text : "";
  const points = useMemo(() => data.features
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) => !feature.geometry || feature.geometry.type === "Point")
    .map(({ feature, index }, ordinal) => {
      const title = String(feature.properties.name || feature.properties.title || `Точка ${ordinal + 1}`);
      const date = typeof feature.properties.date === "string" ? feature.properties.date : "";
      const description = typeof feature.properties.description === "string" ? feature.properties.description : "";
      return { feature, index, title, date, description,
        searchable: searchText(`${title} ${date} ${description}`) };
    }), [data]);
  const terms = searchText(query).trim().split(/\s+/).filter(Boolean);
  const matches = points.filter(point => terms.every(term => point.searchable.includes(term)));
  const [focus, setFocus] = useState<{ data: BiographyMap; index: number } | null>(null);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    return () => {
      requestAnimationFrame(() => {
        if (previous instanceof HTMLElement && previous.isConnected)
          previous.focus();
      });
    };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <section
      className="biography-map-workspace"
      aria-label="Карта из биографии"
    >
      <header>
        <h2>{data.name || "Карта жизни"}</h2>
        <button ref={close} type="button" className="biography-map-close" aria-label={returnLabel} title={returnLabel} onClick={onClose}>
          <span>{returnLabel}</span><X size={22} aria-hidden="true" />
        </button>
      </header>
      <div className="biography-map-body" onPointerDownCapture={event => {
        if (window.matchMedia("(max-width: 899px)").matches &&
          event.target instanceof Element && event.target.closest(".biography-map-surface"))
          setPointsOpen(false);
      }}>
        {points.length > 0 && (
          <div className="biography-map-points-list">
            <button type="button" className="biography-map-points-toggle" aria-expanded={pointsOpen}
              onClick={() => setPointsOpen(!pointsOpen)}>
              <span>Точки маршрута</span><ChevronDown size={16} aria-hidden="true" />
            </button>
            {pointsOpen && <>
            <label className="biography-map-search">
              <Search size={16} aria-hidden="true" />
              <input type="search" aria-label="Поиск по точкам маршрута" placeholder="Название, год, описание…"
                value={query} onChange={event => setSearch({ data, text: event.target.value })} />
            </label>
            <ol className="biography-map-points-results" aria-label="Точки маршрута">
              {matches.map(({ feature: f, index, title, date, description }) => (
                  <li key={index}>
                    <button type="button" className="biography-map-point" disabled={!f.geometry}
                      onClick={() => {
                        setFocus({ data, index });
                        setPointsOpen(false);
                      }}>
                    <strong>{title}</strong>
                    {date && <span>{date}</span>}
                    </button>
                    {!f.geometry && <span>Место не привязано к карте</span>}
                    {description && (
                      <p className={f.geometry ? "biography-map-point-preview" : undefined}>{description}</p>
                    )}
                  </li>
                ))}
            </ol>
            {!matches.length && <p className="biography-map-no-results" role="status">Точки не найдены</p>}
            </>}
          </div>
        )}
        <Suspense fallback={<p role="status">Загрузка карты…</p>}>
          <Surface data={data} focus={focus?.data === data ? focus : null} />
        </Suspense>
      </div>
    </section>
  );
}
