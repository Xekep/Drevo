import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ViewportPortal, useStore } from "@xyflow/react";
import { ArrowLeft, RotateCcw, RotateCw } from "lucide-react";
import { fullName, safeUrl, years, type Person } from "../../domain";
import { depthWorld, projectDepth } from "../../domain/tree-depth-scene";
import { mediaPreview } from "../../domain/media-preview";
import type { TreeGeometry } from "../../domain/tree-layout";
import type { DepthBranch, DepthConnection } from "../../domain/tree-depth";
import "../../styles/tree-depth.css";

type ScreenPoint = { x: number; y: number; scale: number; z: number };
function connectionPath(from: ScreenPoint, to: ScreenPoint, kind: DepthConnection["type"]) {
  const down = Math.sign(to.y - from.y) || 1;
  const side = Math.sign(to.x - from.x) || 1;
  const start = kind === "partner"
    ? { x: from.x + side * 108 * from.scale, y: from.y + 20 * from.scale }
    : { x: from.x, y: from.y + (down > 0 ? 128 : -50) * from.scale };
  const end = kind === "partner"
    ? { x: to.x - side * 108 * to.scale, y: to.y + 20 * to.scale }
    : { x: to.x, y: to.y + (down > 0 ? -50 : 128) * to.scale };
  const bend = Math.min(230, Math.max(55, Math.abs(end.y - start.y) * .4));
  return kind === "partner"
    ? `M${start.x},${start.y} C${start.x + side * 80},${start.y - 40} ${end.x - side * 80},${end.y - 40} ${end.x},${end.y}`
    : `M${start.x},${start.y} C${start.x},${start.y + down * bend} ${end.x},${end.y - down * bend} ${end.x},${end.y}`;
}

/** Upright people in a projected 3D world; real family edges join its planes. */
export function TreeDepthLayers({
  branches, people, anchorId, geometry, previous, disabled, onChoose, onBack,
}: {
  branches: DepthBranch[];
  people: Map<string, Person>;
  anchorId: string;
  geometry: TreeGeometry | null;
  previous?: string;
  disabled: boolean;
  onChoose: (id: string) => void;
  onBack: () => void;
}) {
  const [tx, ty, zoom] = useStore((state) => state.transform);
  const width = useStore((state) => state.width), height = useStore((state) => state.height);
  const [yaw, setYaw] = useState(0);
  const orbitFrame = useRef(0), orbitTarget = useRef(0), currentYaw = useRef(0);
  useEffect(() => () => cancelAnimationFrame(orbitFrame.current), []);
  const turn = (delta: number | null) => {
    cancelAnimationFrame(orbitFrame.current);
    const target = delta === null ? 0 : Math.max(-48, Math.min(48, orbitTarget.current + delta));
    orbitTarget.current = target;
    const start = currentYaw.current, began = performance.now();
    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420;
    const step = (now: number) => {
      const t = duration ? Math.min(1, (now - began) / duration) : 1;
      currentYaw.current = start + (target - start) * (1 - Math.pow(1 - t, 3));
      setYaw(currentYaw.current);
      if (t < 1) orbitFrame.current = requestAnimationFrame(step);
    };
    orbitFrame.current = requestAnimationFrame(step);
  };
  const back = useRef<HTMLButtonElement>(null), restoreFocus = useRef(false), clipId = useId();
  useLayoutEffect(() => {
    if (restoreFocus.current) {
      restoreFocus.current = false;
      back.current?.focus();
    }
  }, [anchorId]);
  const world = useMemo(() => geometry ? depthWorld(branches, people, geometry, anchorId) : null,
    [branches, people, geometry, anchorId]);
  const projected = useMemo(() => world?.scenes.map((scene) => ({ ...scene,
    projected: new Map([...scene.points].map(([id, point]) => [id, projectDepth(point, world.pivot, yaw)])),
  })) || [], [world, yaw]);
  // At normal reading zoom the text has a 14px screen floor. At distant zoom
  // show branch anchors only, rather than overlapping dozens of enlarged labels.
  const readingScale = (point: ScreenPoint) => Math.min(2.6, Math.max(point.scale, .7 / zoom));
  const distant = zoom < .42;
  const visible = projected.filter((scene) => [...scene.projected.values()].some((p) =>
    p.x * zoom + tx > -200 && p.x * zoom + tx < width + 200 &&
    p.y * zoom + ty > -220 && p.y * zoom + ty < height + 220));
  const choose = (id: string) => {
    if (disabled) return;
    restoreFocus.current = true; onChoose(id);
  };
  return <>
    <ViewportPortal>
      <div className="tree-depth-world" role="navigation" aria-label="Ветви 2.5D" data-depth-yaw={yaw.toFixed(2)}>
        <svg className="tree-depth-space" width="1" height="1">
          <defs>
            <clipPath id={clipId}><circle r="37" /></clipPath>
          </defs>
          {visible.flatMap((scene) => scene.branch.connections.filter((edge) =>
            world?.front.has(edge.from) !== world?.front.has(edge.to)).map((edge) => {
            const point = (id: string): ScreenPoint | undefined => {
              const rear = scene.projected.get(id), front = world?.front.get(id);
              return rear ? { ...rear, scale: readingScale(rear) }
                : front ? { ...front, scale: 1 } : undefined;
            };
            const from = point(edge.from), to = point(edge.to);
            return from && to ? <path key={`${edge.from}:${edge.to}`} className="tree-depth-connection"
              data-depth-from={edge.from} data-depth-to={edge.to} d={connectionPath(from, to, edge.type)}>
              <title>{fullName(people.get(edge.from)!)} — {fullName(people.get(edge.to)!)}</title>
            </path> : null;
          }))}
          {visible.map((scene) => <g key={scene.branch.anchorId} className="tree-depth-branch-plane"
            data-branch-anchor={scene.branch.anchorId}>
            {!distant && scene.connections.map((edge) => {
              const from = scene.projected.get(edge.from)!, to = scene.projected.get(edge.to)!;
              return <path className="tree-depth-rear-line" key={`${edge.from}:${edge.to}`}
                d={connectionPath({ ...from, scale: readingScale(from) }, { ...to, scale: readingScale(to) }, edge.type)} />;
            })}
            {[...scene.projected].filter(([id]) => !distant || id === scene.branch.anchorId).map(([id, point]) => {
              const person = people.get(id)!, photo = safeUrl(mediaPreview(person.photo, "thumb"));
              const remainder = id === scene.branch.anchorId
                ? scene.branch.members.length - (distant ? 1 : scene.projected.size) : 0;
              const shortened = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
              return <g key={id} data-depth-person={id} data-depth-z={point.z}
                style={{ transform: `translate(${point.x}px, ${point.y}px) scale(${readingScale(point)})` }}
                className="tree-depth-rear-person nodrag nopan" role="button" tabIndex={disabled ? -1 : 0}
                aria-disabled={disabled}
                aria-label={`Перейти к ветви: ${fullName(person)}, людей: ${scene.branch.members.length}`}
                onClick={(event) => { event.stopPropagation(); choose(id); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault(); event.stopPropagation(); choose(id);
                  }
                }}>
                <rect className="tree-depth-rear-hit" x="-108" y="-50" width="216" height={remainder ? 205 : 178} rx="14" />
                <circle className="tree-depth-rear-portrait" r="39" />
                {photo ? <image href={photo} x="-37" y="-37" width="74" height="74"
                  preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} />
                  : <text className="tree-depth-initial" textAnchor="middle" y="9">{person.name.slice(0, 1)}</text>}
                <text className="tree-depth-person-name" textAnchor="middle" y="62">{shortened(person.surname, 19)}</text>
                <text className="tree-depth-person-given" textAnchor="middle" y="84">
                  {shortened([person.name, person.patronymic].filter(Boolean).join(" "), 25)}</text>
                <text className="tree-depth-person-years" textAnchor="middle" y="107">{years(person)}</text>
                {!!remainder && <text className="tree-depth-more" textAnchor="middle" y="137">Ещё {remainder} в ветви</text>}
                <title>{fullName(person)} · {years(person)}</title>
              </g>;
            })}
          </g>)}
        </svg>
      </div>
    </ViewportPortal>
    <span className="tree-depth-announcement" role="status">
      Ветвь: {people.get(anchorId) ? fullName(people.get(anchorId)!) : ""}. Боковых ветвей: {branches.length}.
    </span>
    <div className="tree-depth-back-controls">
      {previous && <button ref={back} type="button" disabled={disabled}
        aria-label="Предыдущая ветвь" title="Предыдущая ветвь" onClick={() => {
        restoreFocus.current = true; onBack();
      }}><ArrowLeft size={15} aria-hidden="true" /><span>Предыдущая ветвь</span></button>}
      <div className="tree-depth-orbit" role="group" aria-label="Поворот пространства">
        <button type="button" disabled={disabled || yaw <= -48} title="Повернуть пространство влево"
          aria-label="Повернуть пространство влево" onClick={() => turn(-12)}>
          <RotateCcw size={17} aria-hidden="true" /></button>
        <button type="button" disabled={disabled || yaw === 0} title="Вернуть исходный ракурс"
          aria-label="Вернуть исходный ракурс" onClick={() => turn(null)}>2.5D</button>
        <button type="button" disabled={disabled || yaw >= 48} title="Повернуть пространство вправо"
          aria-label="Повернуть пространство вправо" onClick={() => turn(12)}>
          <RotateCw size={17} aria-hidden="true" /></button>
      </div>
    </div>
  </>;
}
