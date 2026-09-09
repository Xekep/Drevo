import { useMemo } from "react";
import { archiveSummary, counted } from "../domain/archive-summary";
import type { Person } from "../domain";

export function ArchiveSummary({
  people,
  detailed = false,
  busy = false,
}: {
  people: Person[];
  detailed?: boolean;
  busy?: boolean;
}) {
  const data = useMemo(() => archiveSummary(people), [people]);
  return (
    <div
      className={`archive-summary${detailed ? " archive-summary-detailed" : ""}`}
      role="group"
      aria-label="Сводка всего семейного архива"
    >
      <div>
        <span>{counted(data.people, ["человек", "человека", "человек"])}</span>
        {!!data.generations && (
          <span title="Самая длинная известная цепочка родителей и детей">
            {counted(data.generations, ["поколение", "поколения", "поколений"])}
          </span>
        )}
      </div>
      {detailed &&
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
