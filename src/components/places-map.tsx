import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { List, LocateFixed, MapPin, Search, X } from "lucide-react";
import {
  fullName,
  dateLabel,
  owns,
  type Family,
  type ArchiveUser,
  type PlaceLocation,
  type Person,
} from "../domain";
import {
  familyPlaces,
  placeKey,
  type PlaceCandidate,
  type PlaceResult,
} from "../domain/places";
import { Avatar } from "./person-panel";
import { portraitMarker, markerPeople } from "./map-portrait-marker";
import { useDockSwipe } from "../hooks/useDockSwipe";

type Point = PlaceCandidate & { key: string; title: string; people: Person[] };
function MapSurface({
  points,
  selected,
  onSelect,
  onPoint,
  picking,
}: {
  points: Point[];
  selected: string;
  onSelect: (id: string) => void;
  onPoint: (point: PlaceCandidate) => void;
  picking: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    handlers = useRef({ onSelect, onPoint, picking }),
    fitted = useRef(false);
  useEffect(() => {
    handlers.current = { onSelect, onPoint, picking };
  }, [onSelect, onPoint, picking]);
  useEffect(() => {
    const instance = L.map(host.current!, {
      zoomControl: false,
      scrollWheelZoom: true,
    }).setView([56, 60], 4);
    instance.attributionControl.setPrefix(false);
    map.current = instance;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(instance);
    L.control.zoom({ position: "bottomright" }).addTo(instance);
    instance.on("click", (e: L.LeafletMouseEvent) => {
      if (handlers.current.picking)
        handlers.current.onPoint({
          lat: e.latlng.lat,
          lon: e.latlng.lng,
          label: "Точка указана на карте",
          name: "",
        });
    });
    const observer = new ResizeObserver(() =>
      instance.invalidateSize({ pan: false }),
    );
    observer.observe(host.current!);
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const layer = L.layerGroup().addTo(instance);
    const buckets = new Map<string, Point[]>();
    for (const p of points) {
      const key = `${p.lat}:${p.lon}`;
      const group = buckets.get(key) || [];
      group.push(p);
      buckets.set(key, group);
    }
    for (const group of buckets.values()) {
      const point = group.find((p) => p.key === selected) || group[0];
      const members = markerPeople(group.flatMap((p) => p.people));
      const portrait = portraitMarker(members);
      const marker = L.marker([point.lat, point.lon], {
        icon: L.divIcon({
          className: `family-map-pin${group.some((p) => p.key === selected) ? " selected" : ""}`,
          html: portrait.content,
          iconSize: [portrait.width, 48],
          iconAnchor: [portrait.width / 2, 24],
        }),
        title: `${group.map((p) => p.title).join(" / ")} · ${members.length} чел.`,
        keyboard: true,
        bubblingMouseEvents: false,
      }).addTo(layer);
      const text = document.createElement("span");
      text.textContent = group.map((p) => p.title).join(" / ");
      marker.bindTooltip(text, { direction: "top", offset: [0, -26] });
      marker.on("click", () => handlers.current.onSelect(point.key));
    }
    if (!fitted.current && points.length) {
      fitted.current = true;
      instance.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon])), {
        maxZoom: 9,
        padding: [40, 40],
        animate: false,
      });
    }
    return () => {
      instance.removeLayer(layer);
    };
  }, [points, selected]);
  const selectedPoint = points.find((p) => p.key === selected);
  const selectedLat = selectedPoint?.lat,
    selectedLon = selectedPoint?.lon;
  useEffect(() => {
    if (selectedLat !== undefined && selectedLon !== undefined && map.current)
      map.current.setView(
        [selectedLat, selectedLon],
        Math.max(7, map.current.getZoom()),
        { animate: false },
      );
  }, [selected, selectedLat, selectedLon]);
  return (
    <div className={`family-map-surface${picking ? " picking" : ""}`}>
      <div
        className="family-map-tiles"
        ref={host}
        role="region"
        aria-label="Карта мест рождения и смерти. Сведения о людях доступны в списке мест."
      />
      <button
        className="map-fit"
        type="button"
        disabled={!points.length}
        onClick={() => {
          if (points.length)
            map.current?.fitBounds(
              L.latLngBounds(points.map((p) => [p.lat, p.lon])),
              { padding: [40, 40], maxZoom: 10 },
            );
        }}
      >
        <LocateFixed size={17} />
        Все места
      </button>
      {picking && (
        <p className="map-pick-notice">Нажмите на нужное место на карте</p>
      )}
    </div>
  );
}

export default function PlacesMap({
  family,
  user,
  canEdit,
  busy,
  save,
  onPerson,
}: {
  family: Family;
  user: ArchiveUser | null;
  canEdit: boolean;
  busy: boolean;
  save: (family: Family) => Promise<Family>;
  onPerson: (id: string) => void;
}) {
  const places = useMemo(() => familyPlaces(family.people), [family.people]);
  const [listOpen, setListOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null),
    drawerHeading = useRef<HTMLDivElement>(null),
    listButton = useRef<HTMLButtonElement>(null);
  const closeList = useCallback(() => {
    setListOpen(false);
    listButton.current?.focus({ preventScroll: true });
  }, []);
  const expandList = useCallback(() => setListOpen(true), []);
  useDockSwipe(sidebar, drawerHeading, true, listOpen, closeList, expandList);
  useEffect(() => {
    if (!listOpen || !matchMedia("(max-width: 899px)").matches) return;
    drawerHeading.current
      ?.querySelector("button")
      ?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeList();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [listOpen, closeList]);
  const [selected, setSelected] = useState(""),
    [results, setResults] = useState<Record<string, PlaceResult>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [loading, setLoading] = useState(false),
    [limit, setLimit] = useState(50),
    [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState(""),
    [candidates, setCandidates] = useState<PlaceCandidate[]>([]),
    [searching, setSearching] = useState(false),
    [error, setError] = useState(""),
    [picking, setPicking] = useState(false),
    [picked, setPicked] = useState<PlaceCandidate | null>(null);
  const request = useRef(0),
    resultRef = useRef(results);
  useEffect(() => {
    resultRef.current = results;
  }, [results]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      for (const place of places.slice(0, limit)) {
        if (!active) break;
        if (place.location || resultRef.current[place.key]) continue;
        try {
          const response = await fetch(
            `/api/places/locate?q=${encodeURIComponent(place.name)}`,
            { headers: { "X-Drevo-Map": "1" }, signal: controller.signal },
          );
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error || "Не удалось найти место");
          if (active) {
            resultRef.current = { ...resultRef.current, [place.key]: result };
            setResults(resultRef.current);
            setErrors((values) => {
              const next = { ...values };
              delete next[place.key];
              return next;
            });
          }
        } catch (e) {
          if (active)
            setErrors((values) => ({
              ...values,
              [place.key]: (e as Error).message,
            }));
        }
      }
      if (active) setLoading(false);
    }
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [places, limit, attempt]);
  const points = useMemo(
    () =>
      places.flatMap((p) => {
        const point = p.location || results[p.key]?.automatic;
        return point
          ? [
              {
                ...point,
                label: point.label || p.name,
                name: p.name,
                key: p.key,
                title: p.name,
                people: p.events.map((e) => e.person),
              },
            ]
          : [];
      }),
    [places, results],
  );
  const current = places.find((p) => p.key === selected),
    editable = canEdit && current?.events.some((e) => owns(user, e.person));
  function select(id: string) {
    request.current++;
    setSelected(id);
    setListOpen(true);
    sidebar.current?.scrollTo({ top: 0 });
    setCandidates([]);
    setSearch(places.find((p) => p.key === id)?.name || "");
    setError("");
    setSearching(false);
    setPicked(null);
    setPicking(false);
  }
  async function find() {
    const id = ++request.current;
    setSearching(true);
    setError("");
    try {
      const response = await fetch(
        `/api/places/locate?q=${encodeURIComponent(search.trim())}`,
        { headers: { "X-Drevo-Map": "1" } },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (request.current === id) {
        setCandidates(data.candidates);
        if (!data.candidates.length)
          setError(
            "Место не найдено. Уточните название или укажите точку на карте.",
          );
      }
    } catch (e) {
      if (request.current === id) setError((e as Error).message);
    } finally {
      if (request.current === id) setSearching(false);
    }
  }
  async function locate(point: PlaceCandidate) {
    if (!current || !editable) return;
    setError("");
    try {
      const next = {
        ...family,
        people: family.people.map((person) => {
          if (!owns(user, person)) return person;
          const updated = { ...person };
          for (const kind of ["birth", "death"] as const)
            if (placeKey(person[`${kind}Place`] || "") === current.key)
              updated[`${kind}Location`] = {
                place: person[`${kind}Place`]!,
                lat: point.lat,
                lon: point.lon,
                label: point.label,
              } satisfies PlaceLocation;
          return updated;
        }),
      };
      await save(next);
      setPicking(false);
      setPicked(null);
      setCandidates([]);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const displayPoints =
    picked && current
      ? [
          ...points.filter((p) => p.key !== current.key),
          {
            ...picked,
            key: current.key,
            title: current.name,
            people: current.events.map((event) => event.person),
          },
        ]
      : points;
  return (
    <section className="places-workspace">
      <header className="places-heading">
        <div>
          <span className="eyebrow">География семьи</span>
          <h1>Места, которые нас связывают</h1>
        </div>
        <p>
          {places.length} мест · {points.length} на карте
          {loading ? " · ищем остальные…" : ""}
        </p>
      </header>
      <div className="places-content">
        <MapSurface
          points={displayPoints}
          selected={selected}
          onSelect={select}
          picking={picking}
          onPoint={setPicked}
        />
        <button
          ref={listButton}
          className="map-list-toggle"
          aria-expanded={listOpen}
          aria-controls="places-list-panel"
          onClick={() => select("")}
        >
          <List size={18} />
          Список мест · {places.length}
        </button>
        <aside
          ref={sidebar}
          id="places-list-panel"
          className={`places-sidebar${listOpen ? " is-open" : ""}`}
          aria-label="Места и люди"
        >
          <div ref={drawerHeading} className="places-drawer-heading">
            <span>
              <i aria-hidden="true" />
              Места семьи
            </span>
            <button onClick={closeList} aria-label="Закрыть список мест">
              <X size={20} />
            </button>
          </div>
          {!current ? (
            <>
              <p className="places-intro">
                Места рождения и смерти из карточек появляются здесь
                автоматически. Точки обозначают населённые пункты; переезды по
                ним не предполагаются.
              </p>
              {!places.length && (
                <p>
                  Укажите место рождения или смерти в карточке человека — оно
                  появится на карте.
                </p>
              )}
              <ul className="places-list">
                {places.map((p) => (
                  <li key={p.key}>
                    <button onClick={() => select(p.key)}>
                      <MapPin size={18} />
                      <span>
                        <b>{p.name}</b>
                        <small>
                          {new Set(p.events.map((e) => e.person.id)).size} чел.
                          ·{" "}
                          {p.location
                            ? "Точка уточнена"
                            : results[p.key]?.automatic
                              ? "Найдено на карте"
                              : errors[p.key]
                                ? "Поиск недоступен"
                                : results[p.key]
                                  ? "Нужно уточнить место"
                                  : "Ожидает поиска"}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {places.length > limit && (
                <button
                  disabled={loading}
                  onClick={() => setLimit((n) => n + 50)}
                >
                  Найти следующие 50 мест
                </button>
              )}
              {!!Object.keys(errors).length && (
                <button
                  disabled={loading}
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  Повторить поиск
                </button>
              )}
            </>
          ) : (
            <>
              <button className="map-back" onClick={() => select("")}>
                <X size={16} />
                Все места
              </button>
              <h2>{current.name}</h2>
              <p className="place-location-label">
                {current.location?.label ||
                  results[current.key]?.automatic?.label ||
                  "Точка ещё не определена"}
              </p>
              {results[current.key]?.automatic?.source && (
                <a
                  className="map-source"
                  href={results[current.key].automatic!.source}
                  target="_blank"
                  rel="noreferrer"
                >
                  Название и координаты в Wikidata
                </a>
              )}
              <ul className="place-events">
                {current.events.map((event) => (
                  <li key={`${event.person.id}:${event.kind}`}>
                    <button onClick={() => onPerson(event.person.id)}>
                      <Avatar person={event.person} />
                      <span>
                        <b>{fullName(event.person)}</b>
                        <small>
                          {event.kind === "birth" ? "Рождение" : "Смерть"}
                          {event.date ? ` · ${dateLabel(event.date)}` : ""}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {editable && (
                <details
                  className="place-correction"
                  open={!current.location && !results[current.key]?.automatic}
                >
                  <summary>Уточнить точку</summary>
                  <p>
                    Историческое название в карточках сохранится. Для поиска
                    можно указать современное название и область.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void find();
                    }}
                  >
                    <label>
                      Название для поиска
                      <input
                        value={search}
                        maxLength={250}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={searching || busy || search.trim().length < 2}
                    >
                      <Search size={16} />
                      Найти
                    </button>
                  </form>
                  <ul className="map-candidates">
                    {(candidates.length
                      ? candidates
                      : results[current.key]?.candidates || []
                    ).map((c) => (
                      <li key={`${c.lat}:${c.lon}`}>
                        <button disabled={busy} onClick={() => void locate(c)}>
                          {c.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setPicking(!picking);
                      setPicked(null);
                    }}
                  >
                    <MapPin size={16} />
                    {picking ? "Завершить выбор точки" : "Указать на карте"}
                  </button>
                  {picked && (
                    <button
                      className="primary-action"
                      disabled={busy}
                      onClick={() => void locate(picked)}
                    >
                      Сохранить выбранную точку
                    </button>
                  )}
                  {error && (
                    <p role="alert" className="form-error">
                      {error}
                    </p>
                  )}
                </details>
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
