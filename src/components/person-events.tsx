import { useState } from "react";
import { CalendarDays, Plus, Trash2 } from "lucide-react";
import type { ClaimConfidence, EventFactAlternative, PersonEvent, Source } from "../domain/types";
import { CLAIM_CONFIDENCE_LABELS } from "../domain/claim-confidence.ts";
import { repositorySummary } from "../domain/person-sources.ts";
import { SourceRepositoryEditor } from "./source-repository-editor.tsx";
import { claimableEventDate, EVENT_NAMES } from "../domain/person-events";
import { dateInputLabel, dateLabel, normalizeDateInput, safeUrl } from "../domain/dates";
import { archiveResourceUrl, scopedArchivePath } from "../domain/archive-context.ts";
import { archiveDocumentPath } from "../domain/archive-routes.ts";
import { DocumentSourcePicker } from "./document-source-picker.tsx";
import { CatalogPicker, CitationSourcesEditor } from "./union-sources-editor.tsx";
import { sourceCitation } from "../shared/source-catalog.ts";
function EventAlternatives({ event, onChange, isAdmin, canAssess, savedIds }: {
  event: PersonEvent;
  onChange: (alternatives: EventFactAlternative[]) => void;
  isAdmin: boolean;
  canAssess: boolean;
  savedIds: ReadonlySet<string>;
}) {
  const alternatives = event.alternatives || [];
  const update = (id: string, patch: Partial<EventFactAlternative>) =>
    onChange(alternatives.map((item) => item.id === id ? { ...item, ...patch } : item));
  const add = (field: EventFactAlternative["field"]) =>
    onChange([...alternatives, { id: crypto.randomUUID(), field, value: "", sources: [] }]);
  return <details className="form-details event-alternatives">
    <summary>Другие записи о событии{alternatives.length ? ` · ${alternatives.length}` : ""}</summary>
    <p>Сохраните отличающуюся дату или место с источником. Показанные дата и место события останутся прежними.</p>
    {alternatives.map((alternative) => {
      const locked = savedIds.has(alternative.id);
      return <section className="fact-alternative" key={alternative.id}>
        <label>{alternative.field === "date" ? "Другая дата" : "Другое место"} события
          <input required readOnly={locked} value={alternative.field === "date"
            ? dateInputLabel(alternative.value) : alternative.value}
            placeholder={alternative.field === "date" ? "Например, 1901 или 12.3.1901" : "Название в документе"}
            onChange={(change) => update(alternative.id, { value: change.target.value })}
            onBlur={() => {
              if (alternative.field !== "date" || locked || !alternative.value.trim()) return;
              try { update(alternative.id, { value: normalizeDateInput(alternative.value) }); }
              catch { /* Сервер проверит дату перед сохранением. */ }
            }} />
        </label>
        {locked && <small>Чтобы изменить вариант, удалите его и добавьте новую запись с источником.</small>}
        <CitationSourcesEditor sources={alternative.sources}
          onChange={(sources) => update(alternative.id, { sources })}
          isAdmin={isAdmin} canRemoveLast={false} />
        <label>Достоверность
          <select value={alternative.confidence || ""} disabled={!canAssess}
            onChange={(change) => update(alternative.id, { confidence: change.target.value
              ? change.target.value as ClaimConfidence : undefined })}>
            <option value="">Не оценено</option>
            {(Object.keys(CLAIM_CONFIDENCE_LABELS) as ClaimConfidence[]).map((status) =>
              <option key={status} value={status}>{CLAIM_CONFIDENCE_LABELS[status]}</option>)}
          </select>
        </label>
        <button type="button" disabled={!!alternative.confidence && !canAssess}
          onClick={() => onChange(alternatives.filter((item) => item.id !== alternative.id))}>
          Удалить вариант
        </button>
      </section>;
    })}
    <button type="button" onClick={() => add("date")}>Добавить другую дату</button>
    <button type="button" onClick={() => add("place")}>Добавить другое место</button>
  </details>;
}
export function EventsEditor({
  events,
  onChange,
  personId,
  isAdmin,
  canAssess,
  savedEvents,
}: {
  events: PersonEvent[];
  onChange: (events: PersonEvent[]) => void;
  personId?: string;
  isAdmin: boolean;
  canAssess: boolean;
  savedEvents?: PersonEvent[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const update = (id: string, patch: Partial<PersonEvent>) =>
    onChange(
      events.map((event) => (event.id === id ? { ...event, ...patch } : event)),
    );
  return (
    <details className="form-details event-editor">
      <summary>
        <CalendarDays size={17} aria-hidden="true" />
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
                disabled={!canAssess && !!(event.dateClaim?.confidence || event.placeClaim?.confidence)}
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
                  disabled={!canAssess && !!(event.dateClaim?.confidence || event.placeClaim?.confidence)}
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
            <details className="event-date-claim">
              <summary>Источники даты события{event.dateClaim?.sources.length
                ? ` · ${event.dateClaim.sources.length}` : ""}</summary>
              {event.dateClaim && event.dateClaim.value !== claimableEventDate(event)
                ? <div>
                    <p role="alert">Дата изменилась. Источники относятся к прежней дате {dateInputLabel(event.dateClaim.value)}.</p>
                    {event.dateClaim.confidence && !canAssess
                      ? <p>Оценку и связь с прежней датой может снять только исследователь или администратор.</p>
                      : <button type="button" onClick={() => update(event.id, { dateClaim: undefined })}>
                          Снять связи с прежней датой
                        </button>}
                  </div>
                : claimableEventDate(event)
                  ? <><CitationSourcesEditor sources={event.dateClaim?.sources || []}
                      onChange={(sources) => update(event.id, { dateClaim: sources.length
                        ? { ...event.dateClaim, value: claimableEventDate(event)!, sources } : undefined })}
                      isAdmin={isAdmin} canRemoveLast={!event.dateClaim?.confidence || canAssess} />
                    {event.dateClaim && <label>Достоверность
                      <select value={event.dateClaim.confidence || ""} disabled={!canAssess}
                        onChange={(change) => update(event.id, { dateClaim: {
                          ...event.dateClaim!, confidence: change.target.value
                            ? change.target.value as ClaimConfidence : undefined,
                        } })}>
                        <option value="">Не оценено</option>
                        {(Object.keys(CLAIM_CONFIDENCE_LABELS) as ClaimConfidence[]).map((status) =>
                          <option key={status} value={status}>{CLAIM_CONFIDENCE_LABELS[status]}</option>)}
                      </select>
                    </label>}</>
                  : <p>Укажите одну дату без периода или приблизительной формулировки, чтобы привязать свидетельство.</p>}
            </details>
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
            <details className="event-place-claim">
              <summary>Источники места события{event.placeClaim?.sources.length
                ? ` · ${event.placeClaim.sources.length}` : ""}</summary>
              {event.placeClaim && event.placeClaim.value !== event.place
                ? <div>
                    <p role="alert">Место изменилось. Источники относятся к прежнему месту {event.placeClaim.value}.</p>
                    {event.placeClaim.confidence && !canAssess
                      ? <p>Оценку и связь с прежним местом может снять только исследователь или администратор.</p>
                      : <button type="button" onClick={() => update(event.id, { placeClaim: undefined })}>
                          Снять связи с прежним местом
                        </button>}
                  </div>
                : event.place?.trim()
                  ? <><CitationSourcesEditor sources={event.placeClaim?.sources || []}
                      onChange={(sources) => update(event.id, { placeClaim: sources.length
                        ? { ...event.placeClaim, value: event.place!, sources } : undefined })}
                      isAdmin={isAdmin} canRemoveLast={!event.placeClaim?.confidence || canAssess} />
                    {event.placeClaim && <label>Достоверность
                      <select value={event.placeClaim.confidence || ""} disabled={!canAssess}
                        onChange={(change) => update(event.id, { placeClaim: {
                          ...event.placeClaim!, confidence: change.target.value
                            ? change.target.value as ClaimConfidence : undefined,
                        } })}>
                        <option value="">Не оценено</option>
                        {(Object.keys(CLAIM_CONFIDENCE_LABELS) as ClaimConfidence[]).map((status) =>
                          <option key={status} value={status}>{CLAIM_CONFIDENCE_LABELS[status]}</option>)}
                      </select>
                    </label>}</>
                  : <p>Укажите место, чтобы привязать к нему свидетельство.</p>}
            </details>
            <EventAlternatives event={event} isAdmin={isAdmin} canAssess={canAssess}
              savedIds={new Set(savedEvents?.find((item) => item.id === event.id)
                ?.alternatives?.map((item) => item.id) || [])}
              onChange={(alternatives) => update(event.id, { alternatives })} />
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
                    disabled={!canAssess && !!(event.dateClaim?.confidence || event.placeClaim?.confidence)}
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
                    {source.catalogId ? <>
                      <strong>{source.title}</strong>
                      {source.reference && <small>{source.reference}</small>}
                    </> : <>
                    <SourceRepositoryEditor source={source} onChange={(next) =>
                      update(event.id, { sources: event.sources!.map((item, i) =>
                        i === index ? next : item) })} />
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
                    <DocumentSourcePicker
                      personId={personId}
                      documentId={source.documentId}
                      pageNumber={source.documentPage}
                      onChange={(document) =>
                        update(event.id, {
                          sources: event.sources!.map((s, i) =>
                            i === index
                              ? {
                                  ...s,
                                  title: s.title || document?.title || "",
                                  documentId: document?.id,
                                  documentPage:
                                    document?.id === s.documentId
                                      ? s.documentPage
                                      : undefined,
                                }
                              : s,
                          ),
                        })
                      }
                      onPageChange={(documentPage) =>
                        update(event.id, {
                          sources: event.sources!.map((s, i) =>
                            i === index ? { ...s, documentPage } : s,
                          ),
                        })
                      }
                    />
                    </>}
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
                {isAdmin && (event.sources?.length || 0) < 50 && <CatalogPicker
                  existing={event.sources || []}
                  onChoose={(entry) => update(event.id, {
                    sources: [...(event.sources || []), sourceCitation(entry)],
                  })}
                />}
              </div>
            </details>
            <button
              className="event-remove"
              type="button"
              disabled={!canAssess && !!(event.dateClaim?.confidence || event.placeClaim?.confidence)}
              onClick={() => onChange(events.filter((e) => e.id !== event.id))}
            >
              <Trash2 size={14} /> Убрать событие
            </button>
            {!canAssess && (event.dateClaim?.confidence || event.placeClaim?.confidence) &&
              <small>Оценённое событие может удалить исследователь или администратор.</small>}
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
function EventSourceList({ label, sources, canLoadDocuments }: {
  label: string; sources: Source[]; canLoadDocuments: boolean;
}) {
  return <details className="event-sources">
    <summary>{label} · {sources.length}</summary>
    {sources.map((source, index) => <p key={index}>
      {source.title}
      {source.reference && ` · ${source.reference}`}
      {source.repository && ` · ${repositorySummary(source)}`}
      {source.note && ` · ${source.note}`}
      {safeUrl(source.url) && <a href={archiveResourceUrl(safeUrl(source.url) || "")}
        target="_blank" rel="noopener noreferrer"> Открыть источник</a>}
      {canLoadDocuments && source.documentId && <a
        href={scopedArchivePath(archiveDocumentPath(null, source.documentId, source.documentPage))}>
        {" "}Открыть документ
      </a>}
    </p>)}
  </details>;
}

export function PersonEvents({
  events,
  canLoadDocuments = false,
}: {
  events?: PersonEvent[];
  canLoadDocuments?: boolean;
}) {
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
              {!!event.sources?.length && <EventSourceList label="Источники"
                sources={event.sources} canLoadDocuments={canLoadDocuments} />}
              {!!event.dateClaim?.sources.length && event.dateClaim.value === claimableEventDate(event) && (
                <EventSourceList label={`Источники даты${event.dateClaim.confidence
                  ? ` · ${CLAIM_CONFIDENCE_LABELS[event.dateClaim.confidence]}` : ""}`}
                  sources={event.dateClaim.sources}
                  canLoadDocuments={canLoadDocuments} />
              )}
              {!!event.placeClaim?.sources.length && event.placeClaim.value === event.place && (
                <EventSourceList label={`Источники места${event.placeClaim.confidence
                  ? ` · ${CLAIM_CONFIDENCE_LABELS[event.placeClaim.confidence]}` : ""}`}
                  sources={event.placeClaim.sources}
                  canLoadDocuments={canLoadDocuments} />
              )}
              {!!event.alternatives?.length && <div className="event-competing-evidence">
                <strong>Другие записи в источниках</strong>
                {event.alternatives.map((alternative) =>
                  <div key={alternative.id} className="event-competing-value">
                    <p>{alternative.field === "date" ? "Другая дата" : "Другое место"}: {alternative.field === "date"
                      ? dateLabel(alternative.value) : alternative.value}
                      {alternative.confidence
                        ? ` · ${CLAIM_CONFIDENCE_LABELS[alternative.confidence]}` : ""}</p>
                    <EventSourceList label="Источники варианта" sources={alternative.sources}
                      canLoadDocuments={canLoadDocuments} />
                  </div>)}
              </div>}
            </div>
          </article>
        ))}
    </section>
  );
}
