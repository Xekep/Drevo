import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  fullName,
  qualityCategory,
  type ArchiveWarning,
  type Family,
} from "../domain";

export function ArchiveWarningCards({
  family,
  warnings,
  onPerson,
}: {
  family: Family;
  warnings: ArchiveWarning[];
  onPerson: (id: string) => void;
}) {
  const [visible, setVisible] = useState(20);
  const people = useMemo(
    () => new Map(family.people.map((person) => [person.id, person])),
    [family.people],
  );
  if (!warnings.length)
    return (
      <p className="insights-clean">В этой категории предупреждений нет.</p>
    );
  return (
    <>
      <div className="insight-warnings">
        {warnings.slice(0, visible).map((warning, index) => (
          <article
            className={`insight-warning is-${warning.level}`}
            key={`${warning.code}:${warning.personIds.join(":")}:${warning.eventId || index}`}
          >
            <AlertTriangle size={16} aria-hidden="true" />
            <div>
              <span className="insight-warning-level">
                {qualityCategory(warning) === "error"
                  ? "Ошибка"
                  : qualityCategory(warning) === "contradiction"
                    ? "Противоречие"
                    : "Нужна проверка"}
              </span>
              <h3>{warning.title}</h3>
              <p>{warning.detail}</p>
              <p className="insight-warning-rule">Почему: {warning.rule}</p>
              {!!warning.sourceTitles?.length && (
                <p className="insight-warning-sources">
                  Связанные источники: {warning.sourceTitles.join(", ")}
                </p>
              )}
              <div className="insight-warning-people">
                {warning.personIds.flatMap((id) => {
                  const person = people.get(id);
                  return person
                    ? [
                        <button
                          type="button"
                          key={id}
                          onClick={() => onPerson(id)}
                        >
                          {fullName(person)} →
                        </button>,
                      ]
                    : [];
                })}
              </div>
            </div>
          </article>
        ))}
      </div>
      {visible < warnings.length && (
        <button
          className="insight-warnings-more"
          type="button"
          onClick={() => setVisible((count) => count + 20)}
        >
          Показать ещё · {warnings.length - visible}
        </button>
      )}
    </>
  );
}
