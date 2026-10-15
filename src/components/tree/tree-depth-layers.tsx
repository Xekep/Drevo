import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, GitBranch } from "lucide-react";
import { fullName, safeUrl, type Person } from "../../domain";
import { householdLevels } from "../../domain/household-levels";
import { mediaPreview } from "../../domain/media-preview";
import type { DepthBranch } from "../../domain/tree-depth";
import "../../styles/tree-depth.css";

function BranchPreview({ people }: { people: Person[] }) {
  const points = useMemo(() => {
    const known = new Set(people.map((p) => p.id));
    const levels = householdLevels(
      people.map((p) => ({
        ...p,
        parents: p.parents.filter((id) => known.has(id)),
        spouses: p.spouses.filter((id) => known.has(id)),
      })),
    );
    const rows = new Map<number, Person[]>();
    for (const p of people) {
      const level = levels.get(p.id) || 0;
      rows.set(level, [...(rows.get(level) || []), p]);
    }
    const ordered = [...rows].sort(([a], [b]) => a - b);
    return new Map(
      ordered.flatMap(([, row], index) =>
        row.map(
          (p, i) =>
            [
              p.id,
              {
                x: 24 + ((i + 0.5) * 140) / row.length,
                y:
                  ordered.length === 1
                    ? 52
                    : 18 + (index * 66) / (ordered.length - 1),
              },
            ] as const,
        ),
      ),
    );
  }, [people]);
  return (
    <svg viewBox="0 0 188 104" aria-hidden="true" focusable="false">
      {people.flatMap((p) =>
        p.parents.map((id) => {
          const from = points.get(id),
            to = points.get(p.id);
          return from && to ? (
            <path
              key={`${id}:${p.id}`}
              d={`M${from.x},${from.y} V${(from.y + to.y) / 2} H${to.x} V${to.y}`}
            />
          ) : null;
        }),
      )}
      {people.map((p) => {
        const point = points.get(p.id)!;
        const photo = safeUrl(mediaPreview(p.photo, "thumb"));
        return (
          <g key={p.id} transform={`translate(${point.x},${point.y})`}>
            <circle r="11" />
            {photo ? (
              <image
                href={photo}
                x="-10"
                y="-10"
                width="20"
                height="20"
                preserveAspectRatio="xMidYMid slice"
              />
            ) : (
              <text textAnchor="middle" y="4">
                {p.name.slice(0, 1)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function TreeDepthLayers({
  branches,
  people,
  anchorId,
  previous,
  disabled,
  onChoose,
  onBack,
}: {
  branches: DepthBranch[];
  people: Map<string, Person>;
  anchorId: string;
  previous?: string;
  disabled: boolean;
  onChoose: (id: string) => void;
  onBack: () => void;
}) {
  const [page, setPage] = useState({ anchor: anchorId, offset: 0 });
  const root = useRef<HTMLElement>(null),
    restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    root.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [anchorId]);
  const offset =
    page.anchor === anchorId
      ? Math.min(page.offset, Math.max(0, branches.length - 3))
      : 0;
  return (
    <nav className="tree-depth-layers" aria-label="Ветви 2.5D" ref={root}>
      <span className="tree-depth-announcement" role="status">
        Ветвь: {people.get(anchorId) ? fullName(people.get(anchorId)!) : ""}.
        Боковых ветвей: {branches.length}.
      </span>
      <div className="tree-depth-heading">
        <GitBranch size={16} aria-hidden="true" />
        <span>Боковые ветви</span>
        {!!branches.length && (
          <span className="tree-depth-count">{branches.length}</span>
        )}
      </div>
      {previous && (
        <button
          type="button"
          className="tree-depth-back"
          onClick={() => {
            restoreFocus.current = true;
            onBack();
          }}
          disabled={disabled}
        >
          <ArrowLeft size={15} aria-hidden="true" />
          Предыдущая ветвь
        </button>
      )}
      <div className="tree-depth-stack">
        {branches.slice(offset, offset + 3).map((branch, layer) => {
          const person = people.get(branch.anchorId)!;
          const preview = [
            person,
            ...branch.members
              .filter((id) => id !== person.id)
              .slice(0, 7)
              .map((id) => people.get(id)!),
          ];
          return (
            <button
              type="button"
              key={branch.anchorId}
              className="tree-depth-branch"
              data-layer={layer}
              data-branch-anchor={branch.anchorId}
              disabled={disabled}
              aria-label={`Перейти к ветви: ${fullName(person)}, людей: ${branch.members.length}`}
              onClick={() => {
                restoreFocus.current = true;
                onChoose(branch.anchorId);
              }}
            >
              <BranchPreview people={preview} />
              <span className="tree-depth-name">{fullName(person)}</span>
              <span className="tree-depth-size">
                {branch.members.length} чел.
              </span>
            </button>
          );
        })}
        {!branches.length && (
          <p className="tree-depth-empty">Все доступные люди в этой ветви</p>
        )}
      </div>
      {branches.length > 3 && (
        <div className="tree-depth-pages">
          <button
            type="button"
            aria-label="Предыдущие боковые ветви"
            disabled={!offset || disabled}
            onClick={() =>
              setPage({ anchor: anchorId, offset: Math.max(0, offset - 3) })
            }
          >
            <ChevronLeft size={17} aria-hidden="true" />
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 3, branches.length)} из{" "}
            {branches.length}
          </span>
          <button
            type="button"
            aria-label="Следующие боковые ветви"
            disabled={offset + 3 >= branches.length || disabled}
            onClick={() => setPage({ anchor: anchorId, offset: offset + 3 })}
          >
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
      )}
    </nav>
  );
}
