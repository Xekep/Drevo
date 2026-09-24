import { useMemo } from "react";
import "../../styles/fan-chart.css";
import {
  ancestorFanSlots,
  fullName,
  years,
  type Family,
} from "../../domain";

const GENERATIONS = 5;
const ROOT_RADIUS = 78;
const RING_WIDTH = 105;
const OUTER_RADIUS = ROOT_RADIUS + (GENERATIONS - 1) * RING_WIDTH;

function polar(radius: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: Math.cos(radians) * radius,
    y: Math.sin(radians) * radius,
  };
}

function sectorPath(
  inner: number,
  outer: number,
  startDegrees: number,
  endDegrees: number,
) {
  const outerStart = polar(outer, startDegrees);
  const outerEnd = polar(outer, endDegrees);
  const innerEnd = polar(inner, endDegrees);
  const innerStart = polar(inner, startDegrees);
  const largeArc = endDegrees - startDegrees > 180 ? 1 : 0;

  if (!inner)
    return [
      `M ${outerStart.x} ${outerStart.y}`,
      `A ${outer} ${outer} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
      "L 0 0 Z",
    ].join(" ");

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function clipped(value: string, limit: number) {
  const clean = value.trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function FanChart({
  family,
  anchorId,
  selected,
  onChoose,
}: {
  family: Family;
  anchorId: string;
  selected: readonly string[];
  onChoose: (id: string) => void;
}) {
  const people = useMemo(
    () => new Map(family.people.map((person) => [person.id, person])),
    [family.people],
  );
  const slots = useMemo(
    () => ancestorFanSlots(family.people, anchorId, GENERATIONS),
    [family.people, anchorId],
  );
  const root = people.get(anchorId);
  if (!root) return null;

  const known = slots.filter((slot) => slot.personId).length;

  return (
    <div className="fan-chart" aria-label={`Веер предков: ${fullName(root)}`}>
      <div className="fan-chart-meta">
        <strong>{fullName(root)}</strong>
        <span>
          {GENERATIONS} поколений · {Math.max(0, known - 1)} известных предков
        </span>
      </div>
      <svg
        className="fan-chart-svg"
        viewBox={`${-OUTER_RADIUS - 28} ${-OUTER_RADIUS - 28} ${(OUTER_RADIUS + 28) * 2} ${OUTER_RADIUS + 94}`}
        role="img"
        aria-label={`Веер предков в пяти поколениях для ${fullName(root)}`}
      >
        {slots.map((slot) => {
          const count = 2 ** slot.generation;
          const angle = 180 / count;
          const start = 180 + slot.index * angle;
          const end = start + angle;
          const inner =
            slot.generation === 0
              ? 0
              : ROOT_RADIUS + (slot.generation - 1) * RING_WIDTH;
          const outer =
            slot.generation === 0
              ? ROOT_RADIUS
              : ROOT_RADIUS + slot.generation * RING_WIDTH;
          const mid = (start + end) / 2;
          const labelRadius =
            slot.generation === 0 ? ROOT_RADIUS * 0.5 : (inner + outer) / 2;
          const label = polar(labelRadius, mid);
          const rotation =
            slot.generation === 0 ? 0 : ((mid + 90) % 360 + 360) % 360;
          const person = slot.personId ? people.get(slot.personId) : undefined;
          const side =
            slot.generation === 0
              ? "root"
              : slot.index < count / 2
                ? "father"
                : "mother";
          const nameLimit = [22, 18, 15, 12, 9][slot.generation] || 9;
          const life = person ? years(person) : "";
          const className = [
            "fan-sector",
            `fan-sector--${side}`,
            person ? "is-known" : "is-empty",
            person && selected.includes(person.id) ? "is-selected" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <g
              key={`${slot.generation}:${slot.index}`}
              className={className}
              role={person ? "button" : undefined}
              tabIndex={person ? 0 : undefined}
              aria-label={
                person
                  ? `${fullName(person)}${life ? `, ${life}` : ""}`
                  : undefined
              }
              onClick={() => person && onChoose(person.id)}
              onKeyDown={(event) => {
                if (
                  person &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  onChoose(person.id);
                }
              }}
            >
              <path d={sectorPath(inner, outer, start, end)} />
              {person ? <title>{fullName(person)}</title> : null}
              {person ? (
                <text
                  className="fan-sector-label"
                  transform={`translate(${label.x} ${label.y}) rotate(${rotation})`}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  aria-hidden="true"
                >
                  <tspan x="0" dy={slot.generation <= 2 ? "-7" : "0"}>
                    {clipped(person.surname || person.name, nameLimit)}
                  </tspan>
                  {slot.generation <= 3 && person.surname && (
                    <tspan x="0" dy="15">
                      {clipped(person.name, nameLimit)}
                    </tspan>
                  )}
                  {slot.generation <= 2 && life && (
                    <tspan className="fan-sector-years" x="0" dy="15">
                      {life}
                    </tspan>
                  )}
                </text>
              ) : slot.generation <= 2 ? (
                <text
                  className="fan-sector-empty-label"
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  aria-hidden="true"
                >
                  ?
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
