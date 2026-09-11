import { useMemo } from "react";
import {
  AlertTriangle,
  Baby,
  BookOpenCheck,
  CalendarRange,
  Camera,
  Clock3,
  MapPin,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { analyzeFamilyInsights, type Family } from "../domain";
import { ArchiveSummary } from "./archive-summary";

export default function InsightsPage({
  family,
  loadingDetails,
  onPerson,
}: {
  family: Family;
  loadingDetails: boolean;
  onPerson: (id: string) => void;
}) {
  const insights = useMemo(() => analyzeFamilyInsights(family), [family]);
  if (!family.people.length)
    return (
      <section className="insights-page insights-empty">
        <Sparkles size={28} />
        <h1>Интересные данные</h1>
        <p>
          Сначала в древе должны появиться люди. Статистика из пустоты пока не
          извлекается.
        </p>
      </section>
    );

  const iconFor = (index: number) =>
    [
      Clock3,
      CalendarRange,
      Baby,
      UsersRound,
      Sparkles,
      UsersRound,
      BookOpenCheck,
      MapPin,
    ][index % 8];

  return (
    <section className="insights-page">
      <header className="insights-heading">
        <div>
          <span className="section-label">АНАЛИТИКА СЕМЕЙНОГО АРХИВА</span>
          <h1>Интересные данные</h1>
          <p>
            Факты рассчитываются из связей, дат, событий и фотографий в архиве.
          </p>
        </div>
        <section
          className="insights-summary"
          aria-label="Семейный архив в цифрах"
        >
          <h2>Наша история в цифрах</h2>
          <ArchiveSummary people={family.people} detailed />
          <p>По известным датам жизни и связям между поколениями.</p>
        </section>
      </header>

      {loadingDetails && (
        <div className="insights-loading" role="status">
          Догружаем биографии, события, источники и фото. Часть показателей ещё
          обновится.
        </div>
      )}

      <div className="insight-facts">
        {insights.facts.map((fact, index) => {
          const Icon = iconFor(index),
            personId =
              fact.personIds?.length === 1 ? fact.personIds[0] : undefined;
          const content = (
            <>
              <span className="insight-fact-icon">
                <Icon size={18} />
              </span>
              <small>{fact.title}</small>
              <strong>{fact.value}</strong>
              <p>{fact.detail}</p>
              {personId && (
                <span className="insight-open">Открыть человека</span>
              )}
            </>
          );
          return personId ? (
            <button
              type="button"
              className="insight-fact is-clickable"
              key={`${fact.title}:${fact.value}`}
              onClick={() => onPerson(personId)}
            >
              {content}
            </button>
          ) : (
            <article
              className="insight-fact"
              key={`${fact.title}:${fact.value}`}
            >
              {content}
            </article>
          );
        })}
      </div>

      <div className="insights-columns secondary">
        <article className="insights-card">
          <header>
            <div>
              <span className="section-label">ФАМИЛИИ И ИМЕНА</span>
              <h2>Что повторяется чаще всего</h2>
            </div>
            <Sparkles size={20} />
          </header>
          <div className="name-ranking">
            <div>
              <h3>Фамилии</h3>
              {insights.topSurnames.map((item, index) => (
                <span key={item.label}>
                  <i>{index + 1}</i>
                  {item.label}
                  <b>{item.count}</b>
                </span>
              ))}
            </div>
            <div>
              <h3>Имена</h3>
              {insights.topNames.map((item, index) => (
                <span key={item.label}>
                  <i>{index + 1}</i>
                  {item.label}
                  <b>{item.count}</b>
                </span>
              ))}
            </div>
          </div>
        </article>

        <article className="insights-card data-card">
          <header>
            <div>
              <span className="section-label">МАТЕРИАЛЫ</span>
              <h2>Что уже есть в архиве</h2>
            </div>
            <Camera size={20} />
          </header>
          <div className="archive-materials">
            <span>
              <Camera size={18} />
              <b>{insights.totals.photos}</b>
              <small>фотографий</small>
            </span>
            <span>
              <CalendarRange size={18} />
              <b>{insights.totals.events}</b>
              <small>событий жизни</small>
            </span>
            <span>
              <BookOpenCheck size={18} />
              <b>{insights.totals.sources}</b>
              <small>источников</small>
            </span>
          </div>
        </article>
      </div>

      <article className="insights-card warnings-card">
        <header>
          <div>
            <span className="section-label">ПРОВЕРКА ДАННЫХ</span>
            <h2>Что стоит перепроверить</h2>
          </div>
          <AlertTriangle size={20} />
        </header>
        {insights.warnings.length ? (
          <div className="insight-warnings">
            {insights.warnings.map((warning, index) => (
              <button
                type="button"
                key={`${warning.title}:${index}`}
                onClick={() => onPerson(warning.personIds[0])}
              >
                <AlertTriangle size={16} />
                <span>
                  <b>{warning.title}</b>
                  <small>{warning.detail}</small>
                </span>
                <em>Показать</em>
              </button>
            ))}
          </div>
        ) : (
          <p className="insights-clean">
            Явных противоречий в известных датах и родительских связях не
            найдено.
          </p>
        )}
      </article>
    </section>
  );
}
