import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ChevronDown,
  ChevronUp,
  Focus,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Scan,
} from "lucide-react";
import { fullName, type Person, type FamilyUnion } from "../../domain";
import { useSpatialWorld } from "./use-spatial-world";
import { SpatialPersonPicker } from "./spatial-person-picker";
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
  disabled,
  cameraRef,
  collapsed,
  onChoose,
  onProfile,
  onSelect,
  onCollapse,
  onFallback,
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
  disabled: boolean;
  cameraRef: RefObject<DepthSceneHandle | null>;
  collapsed: ReadonlySet<string>;
  onChoose: (id: string) => void;
  onProfile: (id: string, additive?: boolean) => void;
  onSelect: (id: string) => void;
  onCollapse: (id: string) => void;
  onFallback: () => void;
  fullscreen: boolean;
  onFullscreen: () => void;
  focusToken?: number;
}) {
  const host = useRef<HTMLDivElement>(null),
    renderer = useRef<SpatialRenderer | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const { world, failed } = useSpatialWorld(layoutPeople, geometry, unions);
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
  const viewStatus = failed ? "failed" : !world || !ready ? "loading" : status;
  return (
    <div
      className="tree-spatial"
      ref={host}
      data-depth-moving="false"
      data-depth-world-people={world?.points.size || 0}
      data-depth-selected={selected.join(",")}
      data-depth-connections={world?.connections.length || 0}
      data-renderer="webgl"
      aria-busy={viewStatus === "loading"}
    >
      {viewStatus === "loading" && (
        <div className="tree-spatial-state" role="status">
          Загружаем 3D-древо…
        </div>
      )}
      {viewStatus === "failed" && (
        <div className="tree-spatial-state" role="alert">
          <p>Не удалось отобразить 3D-древо. Возможно, WebGL недоступен.</p>
          <button type="button" onClick={onFallback}>
            Открыть обычное древо
          </button>
        </div>
      )}
      {viewStatus === "ready" && (
        <>
          {focused && (
            <div
              className="tree-spatial-person"
              aria-label="Выбранный человек в 3D"
            >
              <SpatialPersonPicker
                people={[...people.values()].filter(person => world?.points.has(person.id))}
                focused={focused}
                disabled={disabled}
                onChoose={(id) => {
                  onChoose(id);
                  renderer.current?.focus(id);
                  host.current?.querySelector<HTMLCanvasElement>(".tree-spatial-canvas")
                    ?.focus({ preventScroll: true });
                }}
              />
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
