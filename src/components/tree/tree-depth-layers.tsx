import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Focus,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Scan,
  Users,
} from "lucide-react";
import { fullName, years, type Person, type FamilyUnion } from "../../domain";
import { spatialWorld } from "../../domain/tree-spatial";
import type { TreeGeometry } from "../../domain/tree-layout";
import type { FitTree } from "./tree-camera-fit";
import type { SpatialRenderer } from "./spatial-renderer";
import "../../styles/tree-depth.css";

export type DepthSceneHandle = {
  fit: FitTree;
  zoom: (direction: number) => void;
  personAt: (x: number, y: number) => string | null;
};

/** Lazy loads the renderer only on entry into 3D. No Three.js in the flat chunk. */
export function TreeDepthLayers({
  people,
  layoutPeople,
  unions,
  active,
  selected,
  ready,
  anchorId,
  geometry,
  previous,
  disabled,
  cameraRef,
  collapsed,
  onChoose,
  onProfile,
  onSelect,
  onCollapse,
  onBack,
  onFallback,
  onAdd,
  fullscreen,
  onFullscreen,
  focusToken,
}: {
  people: Map<string, Person>;
  layoutPeople: Map<string, Person>;
  unions?: FamilyUnion[];
  active: ReadonlySet<string>;
  selected: string[];
  ready: boolean;
  anchorId: string;
  geometry: TreeGeometry | null;
  previous?: string;
  disabled: boolean;
  cameraRef: RefObject<DepthSceneHandle | null>;
  collapsed: ReadonlySet<string>;
  onChoose: (id: string) => void;
  onProfile: (id: string, additive?: boolean) => void;
  onSelect: (id: string) => void;
  onCollapse: (id: string) => void;
  onBack: () => void;
  onFallback: () => void;
  onAdd?: () => void;
  fullscreen: boolean;
  onFullscreen: () => void;
  focusToken?: number;
}) {
  const host = useRef<HTMLDivElement>(null),
    renderer = useRef<SpatialRenderer | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [query, setQuery] = useState("");
  const world = useMemo(
    () => (geometry ? spatialWorld(layoutPeople, geometry, unions) : null),
    [layoutPeople, geometry, unions],
  );
  const callbacks = {
    profile: onProfile,
    choose: onChoose,
    select: onSelect,
    failure: () => setStatus("failed"),
  };
  const live = useRef({ people, anchorId, active, callbacks });
  useEffect(() => {
    live.current = { people, anchorId, active, callbacks };
    renderer.current?.update(people, anchorId, active, callbacks);
    if (renderer.current) renderer.current.controls.enabled = !disabled;
  });
  useEffect(() => {
    // A repeated external request for the same person still recentres after an orbit.
    if (focusToken) renderer.current?.focus(anchorId);
  }, [focusToken, anchorId]);
  useEffect(() => {
    const root = host.current;
    if (!root || !world || !ready) return;
    let cancelled = false,
      instance: SpatialRenderer | null = null;
    void import("./spatial-renderer")
      .then(({ SpatialRenderer: Renderer }) => {
        if (cancelled) return;
        try {
          const css = getComputedStyle(root);
          const color = (name: string) => css.getPropertyValue(name).trim();
          instance = new Renderer(
            root,
            world,
            live.current.people,
            {
              paper: color("--paper"),
              ink: color("--ink"),
              muted: color("--muted"),
              green: color("--green"),
              red: color("--red") || "#9c655b",
            },
            live.current.callbacks,
          );
          renderer.current = instance;
          instance.update(
            live.current.people,
            live.current.anchorId,
            live.current.active,
            live.current.callbacks,
          );
          cameraRef.current = {
            fit: instance.fit,
            zoom: (direction) => instance?.zoom(direction),
            personAt: (x, y) => instance?.personAt(x, y) || null,
          };
          setStatus("ready");
        } catch {
          if (!cancelled) setStatus("failed");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });
    return () => {
      cancelled = true;
      instance?.dispose();
      renderer.current = null;
      cameraRef.current = null;
    };
  }, [world, ready, cameraRef]);
  const focused = people.get(selected[0] || anchorId);
  const children =
    focused &&
    [...(world?.connections || [])].some(
      (edge) => edge.type === "parent" && edge.from === focused.id,
    );
  const matches = [...people.values()].filter(
    (p) =>
      world?.points.has(p.id) &&
      fullName(p)
        .toLocaleLowerCase("ru")
        .includes(query.toLocaleLowerCase("ru")),
  );
  return (
    <div
      className="tree-spatial"
      ref={host}
      data-depth-moving="false"
      data-depth-world-people={world?.points.size || 0}
      data-depth-selected={selected.join(",")}
      data-depth-connections={world?.connections.length || 0}
      data-renderer="webgl"
      aria-busy={status === "loading"}
    >
      {status === "loading" && (
        <div className="tree-spatial-state" role="status">
          Загружаем 3D-древо…
        </div>
      )}
      {status === "failed" && (
        <div className="tree-spatial-state" role="alert">
          <p>Не удалось отобразить 3D-древо. Возможно, WebGL недоступен.</p>
          <button type="button" onClick={onFallback}>
            Открыть обычное древо
          </button>
        </div>
      )}
      {status === "ready" && (
        <>
          <details
            className="tree-spatial-people"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <summary title="Найти человека в 3D-древе">
              <Users size={18} aria-hidden="true" />
              <span>Люди в 3D</span>
            </summary>
            <label>
              <span className="sr-only">Поиск в 3D-древе</span>
              <input
                type="search"
                placeholder="Имя или фамилия"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <ul>
              {matches.slice(0, 50).map((person) => (
                <li key={person.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={(e) => {
                      onChoose(person.id);
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      host.current
                        ?.querySelector<HTMLCanvasElement>(
                          ".tree-spatial-canvas",
                        )
                        ?.focus({ preventScroll: true });
                      renderer.current?.focus(person.id);
                    }}
                  >
                    {fullName(person)} · {years(person)}
                  </button>
                </li>
              ))}
            </ul>
            {!matches.length && <p>Никого не нашли</p>}
            {matches.length > 50 && <p>Уточните имя для поиска остальных</p>}
          </details>
          <div
            className="tree-spatial-orbit"
            role="group"
            aria-label="Поворот 3D-древа"
          >
            {previous && (
              <button
                type="button"
                aria-label="Предыдущая ветвь"
                title="Предыдущая ветвь"
                onClick={onBack}
                disabled={disabled}
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <button
              type="button"
              aria-label="Повернуть пространство влево"
              title="Повернуть влево"
              onClick={() => renderer.current?.rotate(-0.35)}
              disabled={disabled}
            >
              <RotateCcw size={18} />
            </button>
            <button
              type="button"
              aria-label="Вернуть ракурс ветви"
              title="Вернуть ракурс ветви"
              onClick={() => renderer.current?.focus(anchorId)}
              disabled={disabled}
            >
              3D
            </button>
            <button
              type="button"
              aria-label="Повернуть пространство вправо"
              title="Повернуть вправо"
              onClick={() => renderer.current?.rotate(0.35)}
              disabled={disabled}
            >
              <RotateCw size={18} />
            </button>
          </div>
          {focused && (
            <div
              className="tree-spatial-person"
              aria-label="Выбранный человек в 3D"
            >
              <button
                type="button"
                className="tree-spatial-person-name"
                onClick={() => onProfile(focused.id)}
                disabled={disabled}
              >
                {fullName(focused)}
              </button>
              <button
                type="button"
                title="Перейти к ветви"
                aria-label={`Перейти к ветви: ${fullName(focused)}`}
                onClick={() => {
                  onChoose(focused.id);
                  renderer.current?.focus(focused.id);
                }}
                disabled={disabled}
              >
                <Focus size={18} />
              </button>
              {(children || collapsed.has(focused.id)) && (
                <button
                  type="button"
                  onClick={() => onCollapse(focused.id)}
                  disabled={disabled}
                  title={
                    collapsed.has(focused.id)
                      ? "Раскрыть ветвь"
                      : "Свернуть ветвь"
                  }
                  aria-label={`${collapsed.has(focused.id) ? "Раскрыть" : "Свернуть"} ветвь: ${fullName(focused)}`}
                >
                  {collapsed.has(focused.id) ? (
                    <ChevronDown size={18} />
                  ) : (
                    <ChevronUp size={18} />
                  )}
                </button>
              )}
            </div>
          )}
          <div
            className="tree-spatial-tools"
            role="group"
            aria-label="Масштаб 3D-древа"
          >
            <button
              type="button"
              aria-label="Уменьшить"
              onClick={() => renderer.current?.zoom(-1)}
              disabled={disabled}
            >
              <Minus size={18} />
            </button>
            <button
              type="button"
              aria-label="Увеличить"
              onClick={() => renderer.current?.zoom(1)}
              disabled={disabled}
            >
              <Plus size={18} />
            </button>
            <button
              type="button"
              title="Вписать видимую часть древа"
              aria-label="Вписать видимую часть древа"
              onClick={() => void renderer.current?.fit()}
              disabled={disabled}
            >
              <Scan size={18} />
            </button>
            <button
              type="button"
              aria-label={
                fullscreen
                  ? "Выйти из полного экрана"
                  : "Развернуть на весь экран"
              }
              title={
                fullscreen
                  ? "Выйти из полного экрана"
                  : "Развернуть на весь экран"
              }
              onClick={onFullscreen}
              disabled={disabled}
            >
              {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          </div>
          {onAdd && (
            <button
              type="button"
              className="tree-spatial-add"
              aria-label="Добавить человека"
              title="Добавить человека"
              onClick={onAdd}
              disabled={disabled}
            >
              <Plus size={18} />
              <span>Человек</span>
            </button>
          )}
          <span className="tree-spatial-hint">
            Перетаскивайте для поворота ·{" "}
            {"ontouchstart" in window
              ? "Два пальца — масштаб и сдвиг"
              : "Колесо — масштаб, правая кнопка — сдвиг"}
          </span>
          <span className="sr-only" role="status">
            Ветвь: {people.get(anchorId) ? fullName(people.get(anchorId)!) : ""}
            . {world?.points.size || 0} человек.
          </span>
        </>
      )}
    </div>
  );
}
