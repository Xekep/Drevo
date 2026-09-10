import { useState } from "react";
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
  const [openId, setOpenId] = useState<string | null>(null);
  const update = (id: string, patch: Partial<PersonEvent>) =>
    onChange(
      events.map((event) => (event.id === id ? { ...event, ...patch } : event)),
    );
  return (
    <details className="form-details event-editor">
      <summary>
        События жизни{events.length ? ` · ${events.length}` : ""}
      </summary>
      {events.map((event) => (
        <details
          className="life-event-editor"
          key={event.id}
          open={openId === event.id}
        >
          <summary
            onClick={(e) => {
              e.preventDefault();
              setOpenId(openId === event.id ? null : event.id);
            }}
          >
            <span>
              <b>{event.title || EVENT_NAMES[event.type]}</b>
              <small>
                {[
                  event.dateText ||
                    [
                      event.date && dateInputLabel(event.date),
                      event.endDate && dateInputLabel(event.endDate),
                    ]
                      .filter(Boolean)
                      .join(" — "),
                  event.place,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </span>
          </summary>
          <div className="life-event-fields">
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
            {event.type === "other" && (
              <label>
                Что произошло
                <input
                  maxLength={1000}
                  placeholder="Название события"
                  value={event.title || ""}
                  onChange={(e) =>
                    update(event.id, { title: e.target.value || undefined })
                  }
                />
              </label>
            )}
            <label>
              Дата
              <input
                value={event.date ? dateInputLabel(event.date) : ""}
                placeholder="Год или д.м.г"
                onChange={(e) =>
                  update(event.id, { date: e.target.value || undefined })
                }
              />
            </label>
            <label>
              Место
              <input
                maxLength={1000}
                placeholder="Город, деревня или адрес"
                value={event.place || ""}
                onChange={(e) =>
                  update(event.id, {
                    place: e.target.value || undefined,
                    location: undefined,
                  })
                }
              />
            </label>
            <details className="event-extra">
              <summary>
                Подробности
                {event.sources?.length
                  ? ` · источников: ${event.sources.length}`
                  : ""}
              </summary>
              <div className="life-event-fields">
                {event.type !== "other" && (
                  <label>
                    Уточнение названия
                    <input
                      maxLength={1000}
                      value={event.title || ""}
                      onChange={(e) =>
                        update(event.id, { title: e.target.value || undefined })
                      }
                    />
                  </label>
                )}
                <label>
                  Конец периода
                  <input
                    value={event.endDate ? dateInputLabel(event.endDate) : ""}
                    placeholder="Если событие длилось несколько лет"
                    onChange={(e) =>
                      update(event.id, { endDate: e.target.value || undefined })
                    }
                  />
                </label>
                <label>
                  Приблизительная дата
                  <input
                    maxLength={1000}
                    placeholder="Например, около 1930 года"
                    value={event.dateText || ""}
                    onChange={(e) =>
                      update(event.id, {
                        dateText: e.target.value || undefined,
                      })
                    }
                  />
                </label>
                <label>
                  Описание
                  <textarea
                    maxLength={10000}
                    rows={3}
                    value={event.description || ""}
                    onChange={(e) =>
                      update(event.id, {
                        description: e.target.value || undefined,
                      })
                    }
                  />
                </label>
                {(event.sources || []).map((source, index) => (
                  <div key={index} className="event-source-editor">
                    <label>
                      Источник
                      <input
                        maxLength={2000}
                        value={source.title}
                        onChange={(e) =>
                          update(event.id, {
                            sources: event.sources!.map((s, i) =>
                              i === index ? { ...s, title: e.target.value } : s,
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
                            sources: event.sources!.map((s, i) =>
                              i === index
                                ? { ...s, url: e.target.value || undefined }
                                : s,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      Архивный шифр
                      <input
                        maxLength={2000}
                        value={source.reference}
                        onChange={(e) =>
                          update(event.id, {
                            sources: event.sources!.map((s, i) =>
                              i === index
                                ? { ...s, reference: e.target.value }
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
                          sources: event.sources!.filter((_, i) => i !== index),
                        })
                      }
                    >
                      Убрать источник
                    </button>
                  </div>
                ))}
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
              </div>
            </details>
            <button
              className="event-remove"
              type="button"
              onClick={() => onChange(events.filter((e) => e.id !== event.id))}
            >
              <Trash2 size={14} /> Убрать событие
            </button>
          </div>
        </details>
      ))}
      <button
        type="button"
        disabled={events.length >= 200}
        onClick={() => {
          const id = crypto.randomUUID();
          onChange([...events, { id, type: "residence" }]);
          setOpenId(id);
        }}
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
