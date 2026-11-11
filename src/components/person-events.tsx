import { externalLinkAttributes } from "../shared/external-links.ts";
import { useState } from "react";
import { researchEvidenceAnchor } from "../domain/research-evidence";
import { CalendarDays, GraduationCap, Plus, Trash2 } from "lucide-react";
import type { ClaimConfidence, EventFactAlternative, PersonEvent, Source } from "../domain/types";
import { CLAIM_CONFIDENCE_LABELS } from "../domain/claim-confidence.ts";
import { repositorySummary } from "../domain/person-sources.ts";
import { SourceRepositoryEditor } from "./source-repository-editor.tsx";
import { claimableEventDate, eventHasEvidence, migrateLegacyEducationEvent, retypeEvent, EVENT_NAMES } from "../domain/person-events";
import { dateInputLabel, dateLabel, normalizeDateInput, safeUrl } from "../domain/dates";
import { PersonDetailDialog } from "./person-detail-dialog";
import { validateEvents } from "../domain/person-events";
import { validateEventEvidence } from "../domain/validation";
import { archiveResourceUrl, scopedArchivePath } from "../domain/archive-context.ts";
import { archiveDocumentPath } from "../domain/archive-routes.ts";
import { DocumentSourcePicker } from "./document-source-picker.tsx";
import { CitationSourcesEditor } from "./union-sources-editor.tsx";
import { HistoricalDateInput } from "./historical-date-input";
import { normalizeEventCalendarDates, julianInputLabel } from "../domain/calendar-dates";
const hasAssessment = (event: PersonEvent) => !!(event.dateClaim?.confidence ||
  event.placeClaim?.confidence || event.alternatives?.some((item) => item.confidence));
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
  if (!alternatives.length) return null;
  return <details className="form-details event-alternatives">
    <summary>Другие записи о событии{alternatives.length ? ` · ${alternatives.length}` : ""}</summary>
    <p>Ранее сохранённые варианты. Дата и место события остаются без изменений.</p>
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
        {locked && <small>Значение сохранено вместе с прежним источником.</small>}
        <CitationSourcesEditor sources={alternative.sources} allowAdd={false}
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
  </details>;
}
export function EventsEditor({
  events: storedEvents,
  onChange: commitEvents,
  personId,
  isAdmin,
  canAssess,
  savedEvents,
  onEditingChange,
  section = "events",
}: {
  events: PersonEvent[];
  onChange: (events: PersonEvent[]) => void;
  personId?: string;
  isAdmin: boolean;
  canAssess: boolean;
  savedEvents?: PersonEvent[];
  onEditingChange?: (dirty: boolean) => void;
  section?: "events" | "education" | "legacy-marriage";
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonEvent | null>(null);
  const [resetEventIds, setResetEventIds] = useState<Set<string>>(() => new Set());
  const events = editing ? storedEvents.some((item) => item.id === editing.id)
    ? storedEvents.map((item) => item.id === editing.id ? editing : item)
    : [...storedEvents, editing] : storedEvents;
  const onChange = (next: PersonEvent[]) => setEditing(next.find((item) => item.id === openId) || null);
  const close = () => {
    setEditing(null); setOpenId(null);
    setResetEventIds((ids) => new Set([...ids].filter((id) => id !== openId)));
  };
  const apply = () => {
    if (!editing) return;
    const normalized = { ...editing,
      ...normalizeEventCalendarDates(editing),
      alternatives: editing.alternatives?.map((item) => ({ ...item,
        value: item.field === "date" ? normalizeDateInput(item.value) : item.value.trim() })),
      sources: editing.sources?.filter((source) => source.catalogId || source.title.trim() ||
        source.type.trim() || source.reference.trim() || source.url?.trim() ||
        source.note?.trim() || source.documentId ||
        (source.repository && Object.values(source.repository).some((value) => value.trim()))),
    };
    validateEvents([normalized]);
    validateEventEvidence(normalized);
    commitEvents(storedEvents.some((item) => item.id === normalized.id)
      ? storedEvents.map((item) => item.id === normalized.id ? normalized : item)
      : [...storedEvents, normalized]);
    close();
  };
  const update = (id: string, patch: Partial<PersonEvent>) =>
    onChange(
      events.map((event) => (event.id === id ? { ...event, ...patch } : event)),
    );
  const citedSavedTypes = new Map(savedEvents?.filter(eventHasEvidence)
    .map((event) => [event.id, event.type]));
  const saveTypeFirst = (event: PersonEvent) =>
    citedSavedTypes.has(event.id) && citedSavedTypes.get(event.id) !== event.type;
  const allowedTypes = Object.entries(EVENT_NAMES).filter(([key]) =>
    section === "education" ? key === "education" : section === "legacy-marriage"
      ? key === "marriage" || key === "divorce"
      : !["education", "marriage", "divorce"].includes(key));
  const shown = events.filter((event) => allowedTypes.some(([key]) => key === event.type));
  if (section === "legacy-marriage" && !shown.length) return null;
  const title = section === "education" ? "Образование" : section === "legacy-marriage"
    ? "Прежние записи о браке" : "События жизни";
  return (
    <details className={`form-details ${section === "events" ? "event-editor" : `${section}-editor`}`}>
      <summary>
        {section === "education" ? <GraduationCap size={17} aria-hidden="true" />
          : <CalendarDays size={17} aria-hidden="true" />}
        {title}{shown.length ? ` · ${shown.length}` : ""}
      </summary>
      {section === "legacy-marriage" && <p>Записи без указанного супруга сохранены. Даты конкретного союза укажите в разделе «Брак».</p>}
      {shown.map((event) => (
        <details
          className="life-event-editor"
          key={event.id}
          open={openId === event.id}
        >
          <summary
            onClick={(e) => {
              e.preventDefault();
              setOpenId(event.id);
              setEditing(migrateLegacyEducationEvent(structuredClone(event)));
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
          {openId === event.id && editing && <PersonDetailDialog
            title={section === "education" ? "Образование" : "Событие жизни"}
            dirty={JSON.stringify(editing) !== JSON.stringify(storedEvents.find((item) => item.id === editing.id)
              || { id: editing.id, type: section === "education" ? "education" : "residence" })}
            onDirtyChange={onEditingChange}
            onClose={close} onApply={apply}>
          <div className="life-event-fields">
            {section === "education" && <label className="education-school">
              Учебное заведение
              <input maxLength={1000} value={event.title || ""}
                placeholder="Школа, колледж, университет"
                disabled={!canAssess && hasAssessment(event)}
                onChange={(change) => update(event.id, { title: change.target.value || undefined })} />
            </label>}
            {section === "education" && <>
              <label>
                Направление / специальность
                <input maxLength={1000} value={event.educationField || ""}
                  placeholder="Например, программная инженерия, электротехника"
                  onChange={(change) => update(event.id, { educationField: change.target.value || undefined })} />
              </label>
              {!event.educationField && !!event.description?.trim() &&
                !event.description.includes("\n") && event.description.length <= 1000 && (
                  <button type="button" className="event-migrate-field"
                    onClick={() => update(event.id, {
                      educationField: event.description?.trim(), description: undefined,
                    })}>
                    Перенести старое описание в направление / специальность
                  </button>
                )}
              <label>
                Квалификация / степень
                <input maxLength={1000} value={event.educationQualification || ""}
                  placeholder="Например, бакалавр, инженер, техник"
                  onChange={(change) => update(event.id, { educationQualification: change.target.value || undefined })} />
              </label>
              <label>
                Результат обучения
                <select value={event.educationStatus || ""}
                  onChange={(change) => update(event.id, {
                    educationStatus: (change.target.value || undefined) as PersonEvent["educationStatus"],
                  })}>
                  <option value="">Не указано</option>
                  <option value="completed">Окончил(а)</option>
                  <option value="ongoing">Учится</option>
                  <option value="unfinished">Не окончил(а)</option>
                </select>
              </label>
            </>}
            {section !== "education" && <label>
              Событие
              <select
                value={event.type}
                disabled={!canAssess && hasAssessment(event)}
                onChange={(e) => {
                  const changed = retypeEvent(event, e.target.value as PersonEvent["type"]);
                  if (changed.removedDetails)
                    setResetEventIds((ids) => new Set(ids).add(event.id));
                  onChange(events.map((item) => item.id === event.id ? changed.event : item));
                }}
              >
                {allowedTypes.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>}
            {event.type === "work" && <>
              <label>
                Организация / место работы
                <input maxLength={1000} value={event.organization || ""}
                  placeholder="Название предприятия или учреждения"
                  onChange={(change) => update(event.id, { organization: change.target.value || undefined })} />
              </label>
              <label>
                Должность / профессия
                <input maxLength={1000} value={event.position || ""}
                  placeholder="Например, слесарь, инженер"
                  onChange={(change) => update(event.id, { position: change.target.value || undefined })} />
              </label>
            </>}
            {event.type === "military" && <>
              <label>
                Воинская часть / подразделение
                <input maxLength={1000} value={event.militaryUnit || ""}
                  placeholder="Например, 544-й стрелковый полк"
                  onChange={(change) => update(event.id, { militaryUnit: change.target.value || undefined })} />
              </label>
              <label>
                Воинское звание
                <input maxLength={1000} value={event.militaryRank || ""}
                  onChange={(change) => update(event.id, { militaryRank: change.target.value || undefined })} />
              </label>
            </>}
            {event.type === "move" && <label>
              Откуда переехал(а)
              <input maxLength={1000} value={event.moveFrom || ""}
                placeholder="Прежний населённый пункт"
                onChange={(change) => update(event.id, { moveFrom: change.target.value || undefined })} />
            </label>}
            {(resetEventIds.has(event.id) || saveTypeFirst(event)) && <p role="status">При смене типа из черновика сняты данные прежнего события: источники, оценки, другие значения или исходный тег GEDCOM. Сохраните новый тип, затем добавьте подходящие данные.</p>}
            {event.type === "other" && (
              <label>
                Что произошло
                <input
                  maxLength={1000}
                  placeholder="Название события"
                  value={event.title || ""}
                  disabled={!canAssess && hasAssessment(event)}
                  onChange={(e) =>
                    update(event.id, { title: e.target.value || undefined })
                  }
                />
              </label>
            )}
            <div className="event-date-field"><HistoricalDateInput label={section === "education" ? "Начало учёбы" : "Дата"}
              date={event.date} dateJulian={event.dateJulian} dateByzantine={event.dateByzantine}
              onChange={(value) => update(event.id, value)} /></div>
            {section === "education" && <div className="event-end-date-field">
              <HistoricalDateInput label="Окончание учёбы" date={event.endDate} dateJulian={event.endDateJulian} dateByzantine={event.endDateByzantine}
                onChange={(value) => update(event.id, { endDate: value.date, endDateJulian: value.dateJulian, endDateByzantine: value.dateByzantine })} />
            </div>}
            {!saveTypeFirst(event) && event.dateClaim && <details className="event-date-claim">
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
                  ? <><CitationSourcesEditor sources={event.dateClaim?.sources || []} allowAdd={false}
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
            </details>}
            <label>
              {section === "education" ? "Место учёбы" : event.type === "work" ? "Место работы" :
                event.type === "military" ? "Место службы" : event.type === "move" ?
                  "Куда переехал(а)" : "Место"}
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
            {!saveTypeFirst(event) && event.placeClaim && <details className="event-place-claim">
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
                  ? <><CitationSourcesEditor sources={event.placeClaim?.sources || []} allowAdd={false}
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
            </details>}
            {!saveTypeFirst(event) && <EventAlternatives event={event} isAdmin={isAdmin} canAssess={canAssess}
              savedIds={new Set(savedEvents?.find((item) => item.id === event.id)
                ?.alternatives?.map((item) => item.id) || [])}
              onChange={(alternatives) => update(event.id, { alternatives })} />}
            <details className="event-extra">
              <summary>
                Подробности
                {event.sources?.length
                  ? ` · источников: ${event.sources.length}`
                  : ""}
              </summary>
              <div className="life-event-fields">
                {event.type !== "other" && section !== "education" && (
                  <label>
                    Уточнение названия
                  <input
                    maxLength={1000}
                    value={event.title || ""}
                    disabled={!canAssess && hasAssessment(event)}
                      onChange={(e) =>
                        update(event.id, { title: e.target.value || undefined })
                      }
                    />
                  </label>
                )}
                {section !== "education" && <HistoricalDateInput label="Конец периода"
                  date={event.endDate} dateJulian={event.endDateJulian} dateByzantine={event.endDateByzantine}
                  onChange={(value) => update(event.id, { endDate: value.date, endDateJulian: value.dateJulian, endDateByzantine: value.dateByzantine })} />}
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
                {!saveTypeFirst(event) && !!event.sources?.length && <>{(event.sources || []).map((source, index) => (
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
                </>}
                <button type="button" className="event-add-source"
                  disabled={(event.sources?.length || 0) >= 50}
                  onClick={() => update(event.id, { sources: [...(event.sources || []),
                    { title: "", type: "", reference: "" }] })}>
                  <Plus size={14} /> Добавить источник (ссылка или документ, необязательно)
                </button>
              </div>
            </details>
            {storedEvents.some((item) => item.id === event.id) && <button
              className="event-remove"
              type="button"
              disabled={!canAssess && hasAssessment(event)}
              onClick={() => { commitEvents(storedEvents.filter((e) => e.id !== event.id)); close(); }}
            >
              <Trash2 size={14} /> {section === "education" ? "Убрать образование" : "Убрать событие"}
            </button>}
            {!canAssess && hasAssessment(event) &&
              <small>Оценённое событие может удалить исследователь или администратор.</small>}
          </div>
          </PersonDetailDialog>}
        </details>
      ))}
      {section !== "legacy-marriage" && <button
        className="event-add"
        type="button"
        disabled={events.length >= 200}
        onClick={() => {
          const id = crypto.randomUUID();
          setEditing({ id, type: section === "education" ? "education" : "residence" });
          setOpenId(id);
        }}
      >
        <Plus size={15} /> {section === "education" ? "Добавить образование" : "Добавить событие"}
      </button>}
    </details>
  );
}
export function EventSourceList({ label, sources, canLoadDocuments }: {
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
        target="_blank" rel="noopener noreferrer" {...externalLinkAttributes(source.url || "")}> Открыть источник</a>}
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
          <article key={event.id} className="life-event" data-evidence={researchEvidenceAnchor("event", event.id)} tabIndex={-1}>
            <span className="event-icon">
              <CalendarDays size={14} />
            </span>
            <div>
              <span className="event-label">{EVENT_NAMES[event.type]}</span>
              {event.title && <strong>{event.title}</strong>}
              {event.type === "education" && event.educationField &&
                <p>Направление / специальность: {event.educationField}</p>}
              {event.type === "education" && event.educationQualification &&
                <p>Квалификация: {event.educationQualification}</p>}
              {event.type === "education" && event.educationStatus &&
                <p>Результат: {({ completed: "окончил(а)", ongoing: "учится",
                  unfinished: "не окончил(а)" })[event.educationStatus]}</p>}
              {event.type === "work" && event.organization &&
                <p>Организация: {event.organization}</p>}
              {event.type === "work" && event.position &&
                <p>Должность: {event.position}</p>}
              {event.type === "military" && event.militaryUnit &&
                <p>Часть: {event.militaryUnit}</p>}
              {event.type === "military" && event.militaryRank &&
                <p>Звание: {event.militaryRank}</p>}
              {event.type === "move" && event.moveFrom &&
                <p>Откуда: {event.moveFrom}</p>}
              {(event.date || event.endDate) && (
                <b>
                  {event.date && dateLabel(event.date)}
                  {event.endDate &&
                    `${event.date ? " — " : "До "}${dateLabel(event.endDate)}`}
                </b>
              )}
              {event.dateByzantine && <small>{julianInputLabel(event.dateByzantine)} по византийской эре</small>}
              {event.dateJulian && <small>{julianInputLabel(event.dateJulian)} по старому стилю</small>}
              {event.endDateByzantine && <small>{julianInputLabel(event.endDateByzantine)} по византийской эре</small>}
              {event.endDateJulian && <small>Окончание: {julianInputLabel(event.endDateJulian)} по старому стилю</small>}
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
