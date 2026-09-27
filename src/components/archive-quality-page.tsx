import { useMemo, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import {
  analyzeArchiveCoverage,
  analyzeArchiveWarnings,
  qualityCategory,
  type Family,
  type QualityCategory,
} from "../domain";
import { ArchiveWarningCards } from "./archive-warning-cards";

const categories: Array<{ id: QualityCategory; label: string }> = [
  { id: "error", label: "Ошибки" },
  { id: "possible-error", label: "Возможные ошибки" },
  { id: "contradiction", label: "Противоречия" },
  { id: "duplicate", label: "Вероятные дубли" },
  { id: "unverified", label: "Неподтверждённые факты" },
  { id: "gap", label: "Пробелы исследования" },
];

export default function ArchiveQualityPage({
  family,
  loadingDetails,
  onPerson,
}: {
  family: Family;
  loadingDetails: boolean;
  onPerson: (id: string) => void;
}) {
  const [filter, setFilter] = useState<QualityCategory | "all">("all");
  const warnings = useMemo(
    () =>
      loadingDetails
        ? []
        : [
            ...analyzeArchiveWarnings(family),
            ...analyzeArchiveCoverage(family),
          ],
    [family, loadingDetails],
  );
  const counts = useMemo(() => {
    const result = new Map<QualityCategory, number>();
    for (const warning of warnings) {
      const category = qualityCategory(warning);
      result.set(category, (result.get(category) || 0) + 1);
    }
    return result;
  }, [warnings]);
  const visible = warnings.filter(
    (warning) => filter === "all" || qualityCategory(warning) === filter,
  );
  return (
    <section className="insights-page quality-page">
      <header className="insights-heading">
        <div>
          <span className="quality-eyebrow">Исследование архива</span>
          <h1>Проверка данных</h1>
          <p>
            Здесь собраны записи, которые стоит сверить с документами. Подсказки
            не меняют архив и не определяют, какой факт верен.
          </p>
        </div>
      </header>
      {loadingDetails ? (
        <div className="insights-loading" role="status">
          Загружаем весь архив для проверки связей и источников…
        </div>
      ) : !family.people.length ? (
        <div className="quality-empty">
          <ClipboardCheck size={30} aria-hidden="true" />
          <h2>Пока нечего проверять</h2>
          <p>Добавьте людей и события — здесь появятся подсказки по записям.</p>
        </div>
      ) : (
        <article className="insights-card quality-results">
          <header>
            <div>
              <h2>Записи для проверки · {warnings.length}</h2>
              <p>
                Отсутствие прикреплённого источника означает пробел в Drevo, а
                не отсутствие документа в реальности. Свидетельства пока не
                сопоставляются автоматически между собой.
              </p>
            </div>
          </header>
          <div
            className="insight-warning-filters"
            aria-label="Категории проверки"
          >
            <button
              type="button"
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              Все <span>{warnings.length}</span>
            </button>
            {categories.map(({ id, label }) => (
              <button
                type="button"
                key={id}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label} <span>{counts.get(id) || 0}</span>
              </button>
            ))}
          </div>
          <ArchiveWarningCards
            key={filter}
            family={family}
            warnings={visible}
            onPerson={onPerson}
          />
        </article>
      )}
    </section>
  );
}
