import { useId, useLayoutEffect, useMemo, useRef } from "react";
import { ViewportPortal, useStore } from "@xyflow/react";
import { ArrowLeft } from "lucide-react";
import { fullName, safeUrl, years, type Person } from "../../domain";
import { householdLevels } from "../../domain/household-levels";
import { mediaPreview } from "../../domain/media-preview";
import type { TreeGeometry } from "../../domain/tree-layout";
import type { DepthBranch } from "../../domain/tree-depth";
import "../../styles/tree-depth.css";

function branchScene(branch: DepthBranch, people: Map<string, Person>) {
  const preview = [
    branch.anchorId,
    ...branch.members.filter((id) => id !== branch.anchorId),
  ]
    .slice(0, 12)
    .map((id) => people.get(id)!)
    .filter(Boolean);
  const known = new Set(preview.map((p) => p.id));
  const levels = householdLevels(
    preview.map((p) => ({
      ...p,
      parents: p.parents.filter((id) => known.has(id)),
      spouses: p.spouses.filter((id) => known.has(id)),
    })),
  );
  const rows = new Map<number, Person[]>();
  for (const person of preview) {
    const level = levels.get(person.id) || 0;
    rows.set(level, [...(rows.get(level) || []), person]);
  }
  const ordered = [...rows].sort(([a], [b]) => a - b);
  const width = Math.max(1, ...ordered.map(([, row]) => row.length)) * 210;
  const points = new Map(
    ordered.flatMap(([, row], level) =>
      row.map(
        (person, column) =>
          [
            person.id,
            {
              x: width / 2 + (column - (row.length - 1) / 2) * 210,
              y: level * 210 + 55,
            },
          ] as const,
      ),
    ),
  );
  return { branch, preview, points, width, height: ordered.length * 210 };
}

/** Rear family planes live in React Flow world coordinates, behind its nodes. */
export function TreeDepthLayers({
  branches,
  people,
  anchorId,
  geometry,
  previous,
  disabled,
  onChoose,
  onBack,
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
  const width = useStore((state) => state.width),
    height = useStore((state) => state.height);
  const back = useRef<HTMLButtonElement>(null),
    restoreFocus = useRef(false),
    clipId = useId();
  useLayoutEffect(() => {
    if (restoreFocus.current) {
      restoreFocus.current = false;
      back.current?.focus();
    }
  }, [anchorId]);
  const scenes = useMemo(() => {
    const occurrence =
      geometry?.occurrences?.find((item) => item.personId === anchorId)?.id ||
      anchorId;
    const position = geometry?.positions.find(([id]) => id === occurrence)?.[1];
    if (!position) return [];
    const anchor = {
      x: position.x + (geometry?.nodeSize?.width || 220) / 2,
      y: position.y + (geometry?.nodeSize?.height || 96) / 2,
    };
    return branches.map((branch, i) => {
      const scene = branchScene(branch, people),
        root = scene.points.get(branch.anchorId)!;
      const scale = 0.7;
      const side = i % 2 ? 1 : -1,
        ring = Math.floor(i / 6),
        row = Math.floor((i % 6) / 2);
      const x = anchor.x + side * (260 + ring * 540) - root.x * scale;
      const y = anchor.y - 170 + row * 390 - root.y * scale;
      return { ...scene, x, y, scale };
    });
  }, [branches, people, anchorId, geometry]);
  const visible = scenes.filter(
    (scene) =>
      scene.x * zoom + tx < width + 240 &&
      scene.y * zoom + ty < height + 240 &&
      (scene.x + scene.width * scene.scale) * zoom + tx > -240 &&
      (scene.y + scene.height * scene.scale) * zoom + ty > -240,
  );
  return (
    <>
      <ViewportPortal>
        <div
          className="tree-depth-world"
          role="navigation"
          aria-label="Ветви 2.5D"
        >
          {visible.map(
            ({ branch, preview, points, width: w, height: h, x, y, scale }, branchIndex) => (
              <svg
                className="tree-depth-branch-plane"
                key={branch.anchorId}
                data-branch-anchor={branch.anchorId}
                width={w}
                height={h}
                style={{
                  transform: `translate(${x}px, ${y}px) scale(${scale})`,
                }}
              >
                <defs>
                  <clipPath id={`${clipId}-${branchIndex}`}>
                    <circle r="37" />
                  </clipPath>
                </defs>
                {preview.flatMap((person) =>
                  person.parents.map((parent) => {
                    const from = points.get(parent),
                      to = points.get(person.id);
                    return from && to ? (
                      <path
                        className="tree-depth-rear-line"
                        key={`${parent}:${person.id}`}
                        d={`M${from.x},${from.y + 118} V${(from.y + to.y + 118) / 2} H${to.x} V${to.y - 41}`}
                      />
                    ) : null;
                  }),
                )}
                {preview.map((person) => {
                  const p = points.get(person.id)!,
                    photo = safeUrl(mediaPreview(person.photo, "thumb"));
                  return (
                    <g
                      key={person.id}
                      transform={`translate(${p.x},${p.y})`}
                      className="tree-depth-rear-person nodrag nopan"
                      role="button"
                      tabIndex={disabled ? -1 : 0}
                      aria-disabled={disabled}
                      aria-label={`Перейти к ветви: ${fullName(person)}, людей: ${branch.members.length}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!disabled) {
                          restoreFocus.current = true;
                          onChoose(person.id);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          if (!disabled) {
                            restoreFocus.current = true;
                            onChoose(person.id);
                          }
                        }
                      }}
                    >
                      <rect
                        className="tree-depth-rear-hit"
                        x="-99"
                        y="-45"
                        width="198"
                        height="153"
                        rx="12"
                      />
                      <circle className="tree-depth-rear-portrait" r="39" />
                      {photo ? (
                        <image
                          href={photo}
                          x="-37"
                          y="-37"
                          width="74"
                          height="74"
                          preserveAspectRatio="xMidYMid slice"
                          clipPath={`url(#${clipId}-${branchIndex})`}
                        />
                      ) : (
                        <text
                          className="tree-depth-initial"
                          textAnchor="middle"
                          y="9"
                        >
                          {person.name.slice(0, 1)}
                        </text>
                      )}
                      <text
                        className="tree-depth-person-name"
                        textAnchor="middle"
                        y="62"
                      >
                        {person.surname.slice(0, 19)}
                      </text>
                      <text
                        className="tree-depth-person-given"
                        textAnchor="middle"
                        y="83"
                      >
                        {[person.name, person.patronymic]
                          .filter(Boolean)
                          .join(" ")
                          .slice(0, 24)}
                      </text>
                      <text
                        className="tree-depth-person-years"
                        textAnchor="middle"
                        y="104"
                      >
                        {years(person)}
                      </text>
                      <title>
                        {fullName(person)} · {years(person)}
                      </title>
                    </g>
                  );
                })}
                {branch.members.length > preview.length && (
                  <text
                    className="tree-depth-more"
                    x={w / 2}
                    y={h - 12}
                    textAnchor="middle"
                  >
                    Ещё {branch.members.length - preview.length} человек в ветви
                  </text>
                )}
              </svg>
            ),
          )}
        </div>
      </ViewportPortal>
      <span className="tree-depth-announcement" role="status">
        Ветвь: {people.get(anchorId) ? fullName(people.get(anchorId)!) : ""}.
        Боковых ветвей: {branches.length}.
      </span>
      {previous && (
        <div className="tree-depth-back-controls">
          <button
            ref={back}
            type="button"
            disabled={disabled}
            onClick={() => {
              restoreFocus.current = true;
              onBack();
            }}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            Предыдущая ветвь
          </button>
        </div>
      )}
    </>
  );
}
