import { CalendarDays, Plus, Trash2 } from "lucide-react";
import type { PersonEvent } from "../domain/types";
import { EVENT_NAMES } from "../domain/person-events";
import { dateInputLabel, dateLabel, safeUrl } from "../domain/dates";
export function EventsEditor({
  events,
  onChange,
}: {
  events: PersonEvent[];
  onChange: (events: PersonEvent[]) => void;
}) {
  const update = (id: string, patch: Partial<PersonEvent>) =>
    onChange(events.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  return (
    <details className="form-details event-editor">
      <summary>
        События жизни{events.length ? ` · ${events.length}` : ""}
      </summary>
      {events.map((event, i) => (
        <fieldset key={event.id}>
          <legend>Событие {i + 1}</legend>
          <label>
            Событие
            <select
              value={event.type}
              onChange={(e) =>
                update(event.id, {
                  type: e.target.value as PersonEvent["type"],
                })
              }
            >
              {Object.entries(EVENT_NAMES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Название или уточнение
            <input
              maxLength={1000}
              placeholder="Например, переезд в Свердловск"
              value={event.title || ""}
              onChange={(e) =>
                update(event.id, { title: e.target.value || undefined })
              }
            />
          </label>
          <div className="event-dates">
            {(["date", "endDate"] as const).map((key) => (
              <label key={key}>
                {key === "date" ? "Дата / начало периода" : "Конец периода"}
                <input
                  value={event[key] ? dateInputLabel(event[key]) : ""}
                  placeholder="д.м.г, м.г или год"
                  onChange={(e) =>
                    update(event.id, { [key]: e.target.value || undefined })
                  }
                />
              </label>
            ))}
          </div>
          <label>
            Если дата приблизительная
            <input
              placeholder="Около 1930 года"
              maxLength={1000}
              value={event.dateText || ""}
              onChange={(e) =>
                update(event.id, { dateText: e.target.value || undefined })
              }
            />
          </label>
          <label>
            Место
            <input
              maxLength={1000}
              value={event.place || ""}
              onChange={(e) =>
                update(event.id, {
                  place: e.target.value || undefined,
                  location: undefined,
                })
              }
            />
          </label>
          <label>
            История события
            <textarea
              maxLength={10000}
              value={event.description || ""}
              onChange={(e) =>
                update(event.id, { description: e.target.value || undefined })
              }
            />
          </label>
          {(event.sources || []).map((source, n) => (
            <div key={n} className="event-source-editor">
              <label>
                Источник
                <input
                  value={source.title}
                  maxLength={2000}
                  onChange={(e) =>
                    update(event.id, {
                      sources: event.sources!.map((s, j) =>
                        j === n ? { ...s, title: e.target.value } : s,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Архивный шифр
                <input
                  value={source.reference}
                  maxLength={2000}
                  onChange={(e) =>
                    update(event.id, {
                      sources: event.sources!.map((s, j) =>
                        j === n ? { ...s, reference: e.target.value } : s,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Ссылка
                <input
                  type="url"
                  value={source.url || ""}
                  onChange={(e) =>
                    update(event.id, {
                      sources: event.sources!.map((s, j) =>
                        j === n
                          ? { ...s, url: e.target.value || undefined }
                          : s,
                      ),
                    })
                  }
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  update(event.id, {
                    sources: event.sources!.filter((_, j) => j !== n),
                  })
                }
              >
                Убрать источник
              </button>
            </div>
          ))}
          <div className="event-editor-actions">
            <button
              type="button"
              disabled={(event.sources?.length || 0) >= 50}
              onClick={() =>
                update(event.id, {
                  sources: [
                    ...(event.sources || []),
                    { title: "", type: "", reference: "" },
                  ],
                })
              }
            >
              Добавить источник
            </button>
            <button
              type="button"
              onClick={() => onChange(events.filter((e) => e.id !== event.id))}
            >
              <Trash2 size={14} /> Убрать событие
            </button>
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={events.length >= 200}
        onClick={() =>
          onChange([...events, { id: crypto.randomUUID(), type: "residence" }])
        }
      >
        <Plus size={15} /> Добавить событие
      </button>
    </details>
  );
}
export function PersonEvents({ events }: { events?: PersonEvent[] }) {
  if (!events?.length) return null;
  return (
    <section className="person-events" aria-label="События жизни">
      <h3>События жизни</h3>
      {[...events]
        .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))
        .map((event) => (
          <article key={event.id} className="life-event">
            <span className="event-icon">
              <CalendarDays size={14} />
            </span>
            <div>
              <span className="event-label">{EVENT_NAMES[event.type]}</span>
              {event.title && <strong>{event.title}</strong>}
              {(event.date || event.endDate) && (
                <b>
                  {event.date && dateLabel(event.date)}
                  {event.endDate &&
                    `${event.date ? " — " : "До "}${dateLabel(event.endDate)}`}
                </b>
              )}
              {event.dateText && <p>{event.dateText}</p>}
              {event.place && <p>{event.place}</p>}
              {event.description && (
                <p className="event-story">{event.description}</p>
              )}
              {!!event.sources?.length && (
                <details className="event-sources">
                  <summary>Источники · {event.sources.length}</summary>
                  {event.sources.map((s, i) => (
                    <p key={i}>
                      {s.title}
                      {s.reference && ` · ${s.reference}`}
                      {s.note && ` · ${s.note}`}
                      {safeUrl(s.url) && (
                        <a
                          href={safeUrl(s.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {" "}
                          Открыть источник
                        </a>
                      )}
                    </p>
                  ))}
                </details>
              )}
            </div>
          </article>
        ))}
    </section>
  );
}
