import { memo, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { ViewportPortal, useReactFlow, useStore } from "@xyflow/react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  GitBranch,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { fullName, years, type Person, type FamilyUnion } from "../../domain";
import {
  depthWorld,
  projectDepth,
  depthLabelMarkers,
  depthContextOffsets,
  type DepthCamera,
  type DepthPoint,
} from "../../domain/tree-depth-scene";
import type { TreeGeometry } from "../../domain/tree-layout";
import type { DepthBranch } from "../../domain/tree-depth";
import { Avatar } from "../person-panel";
import { useLongPress } from "./use-long-press";
import { useDepthCamera } from "./use-depth-camera";
import { fitTreeNodes, type FitTree } from "./tree-camera-fit";
import "../../styles/tree-depth.css";

export type DepthSceneHandle = { fit: FitTree };
type Projected = ReturnType<typeof projectDepth>;

function familyPath(
  from: DepthPoint,
  to: DepthPoint,
  camera: DepthCamera,
  partner: boolean,
  a: Projected,
  b: Projected,
  sourceSize: number,
  targetSize: number,
  sourceHeight: number,
  targetHeight: number,
) {
  const down = Math.sign(to.y - from.y) || 1,
    side = Math.sign(b.x - a.x) || 1;
  if (partner)
    return `M${a.x + side * (sourceHeight === 0 ? 0 : sourceHeight === 30 ? 30 : 110) * sourceSize},${a.y} L${b.x - side * (targetHeight === 0 ? 0 : targetHeight === 30 ? 30 : 110) * targetSize},${b.y}`;
  const middle = (from.y + to.y) / 2;
  const c = projectDepth({ ...from, y: middle }, camera),
    d = projectDepth({ ...to, y: middle }, camera);
  return `M${a.x},${a.y + down * sourceHeight * sourceSize} C${c.x},${c.y} ${d.x},${d.y} ${b.x},${b.y - down * targetHeight * targetSize}`;
}

const DepthPerson = memo(function DepthPerson({
  person,
  point,
  worldPoint,
  projectedPoint,
  marker,
  zoom,
  scale,
  active,
  front,
  anchor,
  selected,
  more,
  relation,
  collapsed,
  hasChildren,
  disabled,
  onChoose,
  onProfile,
  onSelect,
  onCollapse,
}: {
  person: Person;
  point: Projected;
  worldPoint: DepthPoint;
  projectedPoint: Projected;
  marker: boolean;
  zoom: number;
  scale: number;
  active: boolean;
  front: boolean;
  anchor: boolean;
  selected: boolean;
  more: number;
  relation: string;
  collapsed: boolean;
  hasChildren: boolean;
  disabled: boolean;
  onChoose: (id: string) => void;
  onProfile: (id: string, additive?: boolean) => void;
  onSelect: (id: string) => void;
  onCollapse: (id: string) => void;
}) {
  const press = useLongPress(() => onSelect(person.id));
  return (
    <div
      className={`tree-depth-person ${active ? "is-active" : "is-context"} ${marker ? "is-marker" : ""} ${anchor ? "is-anchor" : ""} ${selected ? "is-selected" : ""}`}
      data-depth-person={person.id}
      data-depth-z={point.z.toFixed(2)}
      data-world-x={worldPoint.x}
      data-world-y={worldPoint.y}
      data-world-z={worldPoint.z}
      data-depth-project-x={projectedPoint.x}
      data-depth-project-y={projectedPoint.y}
      data-world-scale={scale.toFixed(3)}
      style={{
        transform: `translate(${point.x}px, ${point.y}px) scale(${scale})`,
        zIndex: Math.round(point.z) + 100000,
        ["--depth-control-size" as string]: `${Math.max(44, 44 / (scale * zoom))}px`,
      }}
    >
      <button
        type="button"
        className="tree-depth-person-content nodrag nopan"
        disabled={disabled}
        data-person-id={person.id}
        title={`${fullName(person)} · ${years(person)}${!active && more ? ` · Ещё ${more} в ветви` : ""}`}
        aria-label={
          front
            ? `Открыть карточку: ${fullName(person)}`
            : `Перейти к ветви: ${fullName(person)}, людей: ${more + 1}`
        }
        onPointerDown={press.handlers.onPointerDown}
        onPointerMove={press.handlers.onPointerMove}
        onPointerUp={press.handlers.onPointerUp}
        onPointerCancel={press.handlers.onPointerCancel}
        onLostPointerCapture={press.handlers.onLostPointerCapture}
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          if (press.suppressClick.current) {
            press.cancel();
            return;
          }
          if (event.shiftKey) onSelect(person.id);
          else if (front) onProfile(person.id);
          else onChoose(person.id);
        }}
      >
        <Avatar person={person} loading="lazy" />
        <span className="tree-depth-person-copy">
          <span className="tree-depth-person-name">{person.surname}</span>
          <span className="tree-depth-person-given">
            {[person.name, person.patronymic].filter(Boolean).join(" ")}
          </span>
          <span className="tree-depth-person-years">{years(person)}</span>
          {active && relation && (
            <span className="tree-depth-person-relation">{relation}</span>
          )}
          {!active && more > 0 && (
            <span className="tree-depth-more">Ещё {more} в ветви</span>
          )}
        </span>
      </button>
      {active && (
        <div className="tree-depth-person-actions nodrag nopan">
          {!anchor && (
            <button
              type="button"
              title="Перейти к этой ветви"
              aria-label={`Перейти к ветви: ${fullName(person)}`}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onChoose(person.id);
              }}
            >
              <GitBranch size={18} aria-hidden="true" />
            </button>
          )}
          {(hasChildren || collapsed) && (
            <button
              type="button"
              disabled={disabled}
              title={collapsed ? "Раскрыть ветвь" : "Свернуть ветвь"}
              aria-label={`${collapsed ? "Раскрыть" : "Свернуть"} ветвь: ${fullName(person)}`}
              onClick={(event) => {
                event.stopPropagation();
                onCollapse(person.id);
              }}
            >
              {collapsed ? (
                <ChevronDown size={18} aria-hidden="true" />
              ) : (
                <ChevronUp size={18} aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/** All people, branch hinges and edges share a world and camera. No CSS plane flight. */
export function TreeDepthLayers({
  branches,
  people,
  layoutPeople,
  unions,
  sceneAnchorId,
  active,
  selected,
  ready,
  anchorId,
  geometry,
  previous,
  disabled,
  cameraRef,
  collapsed,
  relationLabel,
  onChoose,
  onProfile,
  onSelect,
  onCollapse,
  onBack,
}: {
  branches: DepthBranch[];
  people: Map<string, Person>;
  layoutPeople: Map<string, Person>;
  unions?: FamilyUnion[];
  sceneAnchorId: string;
  active: ReadonlySet<string>;
  selected: string[];
  ready: boolean;
  anchorId: string;
  geometry: TreeGeometry | null;
  previous?: string;
  disabled: boolean;
  cameraRef: RefObject<DepthSceneHandle | null>;
  collapsed: ReadonlySet<string>;
  relationLabel: (person: Person) => string;
  onChoose: (id: string) => void;
  onProfile: (id: string, additive?: boolean) => void;
  onSelect: (id: string) => void;
  onCollapse: (id: string) => void;
  onBack: () => void;
}) {
  const [tx, ty, zoom] = useStore((state) => state.transform);
  const width = useStore((state) => state.width),
    height = useStore((state) => state.height);
  const flow = useReactFlow();
  const world = useMemo(
    () =>
      depthWorld(
        branches,
        layoutPeople,
        geometry || {
          positions: [],
          mode: "generations",
          reverse: false,
          start: 0,
          offset: 0,
        },
        sceneAnchorId,
        unions,
      ),
    [branches, layoutPeople, geometry, sceneAnchorId, unions],
  );
  const { camera, moving, offset, turn } = useDepthCamera(
    world,
    anchorId,
    ready,
  );
  const projected = useMemo(
    () =>
      new Map(
        [...world.points].map(([id, p]) => [id, projectDepth(p, camera)]),
      ),
    [world, camera],
  );
  const lastFocused = useRef("");
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // A keyboard branch choice keeps focus on that same person as their card comes forward.
    if (!moving && lastFocused.current) {
      const id = lastFocused.current;
      lastFocused.current = "";
      [
        ...(root.current?.querySelectorAll<HTMLButtonElement>(
          "[data-person-id]",
        ) || []),
      ]
        .find((button) => button.dataset.personId === id)
        ?.focus({ preventScroll: true });
    }
  }, [moving, anchorId]);
  const navigate = (id: string) => {
    if (disabled) return;
    if (root.current?.contains(document.activeElement))
      lastFocused.current = id;
    onChoose(id);
  };
  const detail = (id: string) =>
    active.has(id) && zoom * (projected.get(id)?.scale || 1) >= 0.3;
  const scaleOf = (id: string) =>
    detail(id)
      ? projected.get(id)!.scale
      : Math.max(0.75 / zoom, projected.get(id)!.scale);
  const landmarks = new Set(
    world.planes.flatMap((plane) => [plane.id, ...plane.attachment]),
  );
  const included = new Set(
    [...projected.keys()].filter(
      (id) =>
        detail(id) ||
        landmarks.has(id) ||
        id === anchorId ||
        selected.includes(id),
    ),
  );
  useLayoutEffect(() => {
    cameraRef.current = {
      fit: (options) =>
        fitTreeNodes(
          flow,
          [...projected]
            .filter(([id]) => included.has(id) || options?.ids?.includes(id))
            .map(([id, p]) => {
              const scale = scaleOf(id),
                full = detail(id);
              return {
                id,
                position: {
                  x: p.x - 110 * scale,
                  y: p.y - (full ? 132 : 45) * scale,
                },
                width: 220 * scale,
                height: (full ? 264 : 90) * scale,
              };
            }),
          { width, height },
          options,
        ),
    };
    return () => {
      cameraRef.current = null;
    };
  });
  const candidates = [...projected].filter(
    ([id, p]) =>
      included.has(id) &&
      p.x * zoom + tx > -250 &&
      p.x * zoom + tx < width + 250 &&
      p.y * zoom + ty > -250 &&
      p.y * zoom + ty < height + 250,
  );
  const screenCards = candidates.map(([id, p]) => ({
    id,
    x: p.x * zoom + tx,
    y: p.y * zoom + ty,
    scale: scaleOf(id) * zoom,
    full: detail(id),
  }));
  const offsets = depthContextOffsets(screenCards, width, height);
  const markers = depthLabelMarkers(
    screenCards.map((card) => ({
      ...card,
      x: card.x + (offsets.get(card.id)?.x || 0),
      y: card.y + (offsets.get(card.id)?.y || 0),
    })),
  );
  const offsetPoint = (id: string, p: Projected) => ({
    ...p,
    x: p.x + (offsets.get(id)?.x || 0) / zoom,
    y: p.y + (offsets.get(id)?.y || 0) / zoom,
  });
  const shifted = (id: string) =>
    Math.hypot(offsets.get(id)?.x || 0, offsets.get(id)?.y || 0) > 0.01;
  const hasChildren = new Set(
    world.connections
      .filter((edge) => edge.type === "parent")
      .map((edge) => edge.from),
  );
  return (
    <>
      <ViewportPortal>
        <div
          ref={root}
          className="tree-depth-world"
          role="navigation"
          aria-label="Ветви 2.5D"
          data-depth-yaw={camera.yaw.toFixed(2)}
          data-depth-moving={moving}
          data-depth-world-people={world.points.size}
          style={{ visibility: ready ? "visible" : "hidden" }}
        >
          <svg
            className="tree-depth-space"
            width="1"
            height="1"
            aria-hidden="true"
          >
            {world.connections
              .filter(
                (edge) => included.has(edge.from) && included.has(edge.to),
              )
              .map((edge) => {
                const a = projected.get(edge.from)!,
                  b = projected.get(edge.to)!;
                return (
                  <path
                    key={`${edge.type}:${edge.from}:${edge.to}`}
                    className={`tree-depth-connection ${edge.type === "partner" ? "is-partner" : ""}`}
                    data-depth-from={edge.from}
                    data-depth-to={edge.to}
                    d={familyPath(
                      world.points.get(edge.from)!,
                      world.points.get(edge.to)!,
                      camera,
                      edge.type === "partner",
                      a,
                      b,
                      scaleOf(edge.from),
                      scaleOf(edge.to),
                      shifted(edge.from)
                        ? 0
                        : detail(edge.from)
                          ? 132
                          : markers.has(edge.from)
                            ? 30
                            : 45,
                      shifted(edge.to)
                        ? 0
                        : detail(edge.to)
                          ? 132
                          : markers.has(edge.to)
                            ? 30
                            : 45,
                    )}
                  />
                );
              })}
            {candidates
              .filter(([id]) => shifted(id))
              .map(([id, p]) => {
                const label = offsetPoint(id, p);
                return (
                  <path
                    key={`leader:${id}`}
                    data-depth-leader={id}
                    className="tree-depth-label-leader"
                    d={`M${p.x},${p.y} L${label.x},${label.y}`}
                  />
                );
              })}
          </svg>
          {candidates.map(([id, point]) => (
            <DepthPerson
              key={id}
              person={people.get(id)!}
              point={offsetPoint(id, point)}
              projectedPoint={point}
              worldPoint={world.points.get(id)!}
              marker={markers.has(id)}
              zoom={zoom}
              scale={scaleOf(id)}
              active={detail(id)}
              front={active.has(id)}
              anchor={id === anchorId}
              selected={selected.includes(id)}
              more={Math.max(
                0,
                (world.planeOf.get(id)?.members.length || 1) - 1,
              )}
              relation={relationLabel(people.get(id)!)}
              collapsed={collapsed.has(id)}
              hasChildren={hasChildren.has(id)}
              disabled={disabled || !ready}
              onChoose={navigate}
              onProfile={onProfile}
              onSelect={onSelect}
              onCollapse={onCollapse}
            />
          ))}
        </div>
      </ViewportPortal>
      <span className="tree-depth-announcement" role="status">
        Ветвь: {people.get(anchorId) ? fullName(people.get(anchorId)!) : ""}.
      </span>
      <div className="tree-depth-back-controls">
        {previous && (
          <button
            type="button"
            disabled={disabled}
            aria-label="Предыдущая ветвь"
            title="Предыдущая ветвь"
            onClick={onBack}
          >
            <ArrowLeft size={17} aria-hidden="true" />
            <span>Предыдущая ветвь</span>
          </button>
        )}
        <div
          className="tree-depth-orbit"
          role="group"
          aria-label="Поворот пространства"
        >
          <button
            type="button"
            disabled={disabled || offset <= -36}
            title="Повернуть пространство влево"
            aria-label="Повернуть пространство влево"
            onClick={() => turn(-12)}
          >
            <RotateCcw size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={disabled || offset === 0}
            title="Вернуть ракурс ветви"
            aria-label="Вернуть ракурс ветви"
            onClick={() => turn(null)}
          >
            2.5D
          </button>
          <button
            type="button"
            disabled={disabled || offset >= 36}
            title="Повернуть пространство вправо"
            aria-label="Повернуть пространство вправо"
            onClick={() => turn(12)}
          >
            <RotateCw size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  );
}
