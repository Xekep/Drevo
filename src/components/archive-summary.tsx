import { useMemo } from "react";
import { archiveSummary, counted } from "../domain/archive-summary";
import type { Person } from "../domain";

export function ArchiveSummary({
  people,
  detailed = false,
  busy = false,
  selectedCount,
}: {
  people: Person[];
  detailed?: boolean;
  busy?: boolean;
  selectedCount?: number;
}) {
  const data = useMemo(() => archiveSummary(people), [people]);
  return (
    <div
      className={`archive-summary${detailed ? " archive-summary-detailed" : ""}${selectedCount !== undefined ? " archive-summary-selection" : ""}`}
      role="group"
      aria-label={selectedCount !== undefined ? "Сводка выборки древа" : "Сводка всего семейного архива"}
      aria-live={selectedCount !== undefined ? "polite" : undefined}
      aria-atomic={selectedCount !== undefined ? true : undefined}
    >
      <div>
        <span>{selectedCount !== undefined ? `Выборка: ${selectedCount} из ${data.people}` : counted(data.people, ["человек", "человека", "человек"])}</span>
        {selectedCount === undefined && !!data.generations && (
          <span title="Самая длинная известная цепочка родителей и детей">
            {counted(data.generations, ["поколение", "поколения", "поколений"])}
          </span>
        )}
      </div>
      {detailed && selectedCount === undefined &&
        (data.first !== undefined && data.last !== undefined ? (
          <div title="По известным датам рождения и смерти. Неизвестные даты не подставляются.">
            <span>
              {data.first === data.last
                ? data.first
                : `${data.first}–${data.last}`}
            </span>
            {data.span! > 0 && (
              <span>{counted(data.span!, ["год", "года", "лет"])} истории</span>
            )}
          </div>
        ) : (
          !!people.length && <div>Годы истории пока неизвестны</div>
        ))}
      {busy && (
        <span className="summary-busy" role="status">
          Расставляем карточки…
        </span>
      )}
    </div>
  );
}
