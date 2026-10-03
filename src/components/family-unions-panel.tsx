import { useState } from "react";
import {
  fullName,
  unionStatus,
  type ArchiveUser,
  type Family,
  type FamilyUnion,
  type UnionMilestone,
  type ClaimConfidence,
  CLAIM_CONFIDENCE_LABELS,
} from "../domain";
import { UnionSourcesEditor } from "./union-sources-editor.tsx";

const names = {
  marriage: "Брак",
  civil_union: "Гражданский союз",
  partnership: "Партнёрство",
} as const;
const statusNames = {
  current: "Действует по подтверждению",
  former: "Завершён",
  unknown: "Статус неизвестен",
} as const;
const empty = (participants: [string, string]): FamilyUnion => ({
  id: crypto.randomUUID(),
  participants,
  type: "marriage",
});

export function FamilyUnionsPanel({
  family,
  participants,
  user,
  editable,
  save,
  busy,
  onSaved,
}: {
  family: Family;
  participants: [string, string];
  user: ArchiveUser | null;
  editable: boolean;
  save: (family: Family) => Promise<Family>;
  busy: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<FamilyUnion | null>(null);
  const [error, setError] = useState("");
  const [sourcesReset, setSourcesReset] = useState(false);
  const [assessmentReset, setAssessmentReset] = useState(false);
  const [unionAssessmentReset, setUnionAssessmentReset] = useState(false);
  const canAssess = user?.role === "admin" || user?.role === "researcher";
  const unions = (family.unions || []).filter((union) =>
    participants.every((id) => union.participants.includes(id)),
  );
  const people = participants.map((id) =>
    family.people.find((person) => person.id === id),
  );
  const mayCreate =
    editable &&
    !!user &&
    (user.role === "admin" ||
      people.every((person) => person?.createdBy === user.id));
  const mayEdit = (union: FamilyUnion) =>
    mayCreate && (user?.role === "admin" || union.createdBy === user?.id);
  const original = (family.unions || []).find((union) => union.id === draft?.id);
  const saveIdentityFirst = !!original && !!draft && original.type !== draft.type &&
    [original.sources, original.formation?.sources, original.ending?.sources,
      original.divorce?.sources, original.ongoing?.sources].some((sources) => sources?.length);
  const saveAssessmentFirst = !!original && !!draft && original.type !== draft.type &&
    [original.formation, original.ending, original.divorce, original.ongoing]
      .some((stage) => stage?.confidence);
  const saveUnionAssessmentFirst = !!original?.confidence && !!draft &&
    original.type !== draft.type;
  const saveStageFirst = (key: "formation" | "ending" | "divorce" | "ongoing") => {
    const before = original?.[key], after = draft?.[key];
    return !!before?.confidence &&
      (before.date !== after?.date || before.dateText !== after?.dateText ||
        before.place !== after?.place);
  };
  const stageLocked = (key: "formation" | "ending" | "divorce" | "ongoing") =>
    !canAssess && (!!draft?.[key]?.confidence ||
      (key === "ending" && !!draft?.divorce?.confidence) ||
      (key === "divorce" && !!draft?.ending?.confidence));
  const patch = (value: Partial<FamilyUnion>) =>
    setDraft((old) => old && { ...old, ...value });
  const milestone = (
    key: "formation" | "ending" | "divorce" | "ongoing",
    field: keyof UnionMilestone,
    value: string,
  ) => {
    const changedAssessedValue = field !== "confidence" && !!draft?.[key]?.confidence &&
      draft[key]?.[field] !== (value || undefined);
    const replacedAssessedEnding = !!value &&
      ((key === "ending" && !!draft?.divorce?.confidence) ||
        (key === "divorce" && !!draft?.ending?.confidence));
    if (changedAssessedValue || replacedAssessedEnding)
      setAssessmentReset(true);
    setDraft(
      (old) => {
        if (!old) return old;
        return {
          ...old,
          ...(value && key === "ending" ? { divorce: undefined } : {}),
          ...(value && key === "divorce" ? { ending: undefined } : {}),
          [key]: { ...old[key], [field]: value || undefined,
            ...(field !== "confidence" && old[key]?.[field] !== (value || undefined)
              ? { confidence: undefined } : {}) },
        };
      },
    );
  };
  const milestoneSources = (
    key: "formation" | "ending" | "divorce" | "ongoing",
    sources: UnionMilestone["sources"],
  ) => setDraft((old) => old && {
    ...old,
    [key]: { ...old[key], sources },
  });
  const submit = async (remove = false) => {
    if (!draft) return;
    setError("");
    try {
      const next = (family.unions || []).filter(
        (union) => union.id !== draft.id,
      );
      if (!remove) next.push(draft);
      await save({ ...family, unions: next });
      setDraft(null);
      setSourcesReset(false);
      setAssessmentReset(false);
      setUnionAssessmentReset(false);
      onSaved();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  return (
    <section
      className="archive-form family-unions-panel"
      aria-label="Семейные союзы"
    >
      <h3>Семейные союзы</h3>
      <p>
        События в карточке человека без указанного партнёра не определяют статус
        этого союза.
      </p>
      {unions.map((union) => (
        <div key={union.id} className="event-card">
          <strong>
            {names[union.type]} · {statusNames[unionStatus(union)]}
          </strong>
          {union.confidence && <p>Оценка союза: {CLAIM_CONFIDENCE_LABELS[union.confidence]}</p>}
          <p>
            {union.formation?.dateText ||
              union.formation?.date ||
              "Дата заключения неизвестна"}
            {union.formation?.place ? ` · ${union.formation.place}` : ""}
          </p>
          {union.formation?.confidence && <p>Оценка заключения: {CLAIM_CONFIDENCE_LABELS[union.formation.confidence]}</p>}
          {union.divorce?.confidence && <p>Оценка развода: {CLAIM_CONFIDENCE_LABELS[union.divorce.confidence]}</p>}
          {union.ending?.confidence && <p>Оценка окончания: {CLAIM_CONFIDENCE_LABELS[union.ending.confidence]}</p>}
          {union.ongoing?.confidence && <p>Оценка продолжения: {CLAIM_CONFIDENCE_LABELS[union.ongoing.confidence]}</p>}
          {(union.divorce || union.ending) && (
            <p>
              {union.divorce ? "Развод" : "Окончание"}:{" "}
              {(union.divorce || union.ending)?.dateText ||
                (union.divorce || union.ending)?.date ||
                "дата неизвестна"}
            </p>
          )}
          {union.note && <p>{union.note}</p>}
          {mayEdit(union) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => { setSourcesReset(false); setAssessmentReset(false); setUnionAssessmentReset(false); setDraft(structuredClone(union)); }}
            >
              Изменить союз
            </button>
          )}
        </div>
      ))}
      {!unions.length && <p>Для этой пары союз ещё не описан.</p>}
      {mayCreate && !draft && (
        <button
          type="button"
          disabled={busy}
          onClick={() => { setSourcesReset(false); setAssessmentReset(false); setUnionAssessmentReset(false); setDraft(empty(participants)); }}
        >
          Добавить союз
        </button>
      )}
      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p>
            {people
              .map((person) => (person ? fullName(person) : ""))
              .join(" — ")}
          </p>
          <label>
            Тип союза
            <select
              value={draft.type}
              disabled={!canAssess && (!!draft.confidence ||
                [draft.formation, draft.ending, draft.divorce, draft.ongoing]
                  .some((stage) => stage?.confidence))}
              onChange={(event) => {
                const type = event.target.value as FamilyUnion["type"];
                if (type === draft.type) return;
                const hadSources = [draft.sources, draft.formation?.sources,
                  draft.ending?.sources, draft.divorce?.sources,
                  draft.ongoing?.sources].some((sources) => sources?.length);
                setSourcesReset((previous) => previous || hadSources);
                if (draft.confidence) setUnionAssessmentReset(true);
                if ([draft.formation, draft.ending, draft.divorce, draft.ongoing]
                  .some((stage) => stage?.confidence)) setAssessmentReset(true);
                patch({
                  type,
                  confidence: undefined,
                  sources: undefined,
                  formation: draft.formation && { ...draft.formation, sources: undefined, confidence: undefined },
                  ending: draft.ending && { ...draft.ending, sources: undefined, confidence: undefined },
                  divorce: type === "marriage" && draft.divorce
                    ? { ...draft.divorce, sources: undefined, confidence: undefined }
                    : undefined,
                  ongoing: draft.ongoing && { ...draft.ongoing, sources: undefined, confidence: undefined },
                });
              }}
            >
              {Object.entries(names).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {saveUnionAssessmentFirst
            ? <p>Сначала сохраните новый тип союза, затем оцените сам союз заново.</p>
            : <label>
                Статус достоверности союза
                <select value={draft.confidence || ""} disabled={!canAssess}
                  onChange={(event) => patch({ confidence: event.target.value
                    ? event.target.value as ClaimConfidence : undefined })}>
                  <option value="">Оценка не задана</option>
                  {(Object.keys(CLAIM_CONFIDENCE_LABELS) as ClaimConfidence[]).map((status) =>
                    <option key={status} value={status}>{CLAIM_CONFIDENCE_LABELS[status]}</option>)}
                </select>
              </label>}
          {unionAssessmentReset && <p role="status">Оценка прежнего типа союза снята. Сохраните новый тип, затем оцените союз заново.</p>}
          {sourcesReset && <p role="status">
            Прежние источники союза и его этапов сняты при смене типа.
            {saveIdentityFirst
              ? " Сохраните новый тип, затем при необходимости добавьте источники заново."
              : " При необходимости добавьте подходящие источники заново."}
          </p>}
          {assessmentReset && <p role="status">Оценка достоверности прежнего этапа снята. Проверьте новые сведения и оцените их заново.</p>}
          {(["formation", "ending", "divorce", "ongoing"] as const)
            .filter((key) => key !== "divorce" || draft.type === "marriage")
            .map((key) => (
              <fieldset key={key}>
                <legend>
                  {
                    {
                      formation: "Заключение",
                      ending: "Окончание",
                      divorce: "Развод",
                      ongoing: "Подтверждение действующего союза",
                    }[key]
                  }
                </legend>
                <label>
                  Дата (год, месяц или день)
                  <input
                    value={draft[key]?.date || ""}
                    disabled={stageLocked(key)}
                    onChange={(event) =>
                      milestone(key, "date", event.target.value)
                    }
                    placeholder="1900-05-12"
                  />
                </label>
                {key === "ongoing" && (
                  <button
                    type="button"
                    disabled={stageLocked("ongoing")}
                    onClick={() =>
                      milestone(
                        "ongoing",
                        "date",
                        new Date().toISOString().slice(0, 10),
                      )
                    }
                  >
                    Подтвердить на сегодня
                  </button>
                )}
                <label>
                  Приблизительная дата
                  <input
                    value={draft[key]?.dateText || ""}
                    disabled={stageLocked(key)}
                    onChange={(event) =>
                      milestone(key, "dateText", event.target.value)
                    }
                    placeholder="около 1900 года"
                  />
                </label>
                <label>
                  Место
                  <input
                    value={draft[key]?.place || ""}
                    disabled={stageLocked(key)}
                    onChange={(event) =>
                      milestone(key, "place", event.target.value)
                    }
                  />
                </label>
                {(key === "ending" && draft.divorce) ||
                  (key === "divorce" && draft.ending)
                  ? <small>Оценку можно добавить после выбора этого этапа вместо другого завершения союза.</small>
                  : saveIdentityFirst || saveAssessmentFirst || saveStageFirst(key)
                  ? <p>Сначала сохраните изменённый союз, затем оцените этап заново.</p>
                  : <label>
                      Статус достоверности этапа
                      <select value={draft[key]?.confidence || ""} disabled={!canAssess}
                        onChange={(event) => milestone(key, "confidence",
                          event.target.value as ClaimConfidence)}>
                        <option value="">Оценка не задана</option>
                        {(Object.keys(CLAIM_CONFIDENCE_LABELS) as ClaimConfidence[]).map((status) =>
                          <option key={status} value={status}>{CLAIM_CONFIDENCE_LABELS[status]}</option>)}
                      </select>
                    </label>}
                {(key === "ending" && draft.divorce) || (key === "divorce" && draft.ending)
                  ? <small>Источники можно добавить после выбора этого этапа вместо другого завершения союза.</small>
                  : saveIdentityFirst ? <p>Сначала сохраните новый тип союза, затем добавьте источники этапа.</p>
                  : <details className="union-milestone-sources">
                      <summary>Источники этапа ({draft[key]?.sources?.length || 0})</summary>
                      <UnionSourcesEditor sources={draft[key]?.sources || []}
                        isAdmin={user?.role === "admin"}
                        onChange={(sources) => milestoneSources(key, sources)} />
                    </details>}
              </fieldset>
            ))}
          <label>
            Примечание
            <textarea
              value={draft.note || ""}
              onChange={(event) => patch({ note: event.target.value })}
            />
          </label>
          <fieldset>
            <legend>Источники союза</legend>
            {saveIdentityFirst ? <p>Сначала сохраните новый тип союза, затем добавьте источники.</p>
              : <UnionSourcesEditor sources={draft.sources || []}
                isAdmin={user?.role === "admin"}
                onChange={(sources) => patch({ sources })} />}
          </fieldset>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button className="primary-action" disabled={busy}>
            Сохранить союз
          </button>
          <button type="button" disabled={busy} onClick={() => { setDraft(null); setSourcesReset(false); setAssessmentReset(false); setUnionAssessmentReset(false); }}>
            Отмена
          </button>
          {unions.some((union) => union.id === draft.id) && (
            <button
              type="button"
              className="danger-action"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              Удалить союз
            </button>
          )}
        </form>
      )}
    </section>
  );
}
