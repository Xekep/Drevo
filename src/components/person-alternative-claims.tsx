import { CLAIM_CONFIDENCE_LABELS, dateInputLabel, normalizeDateInput,
  type ClaimConfidence, type PersonFactAlternative } from "../domain";
import { CitationSourcesEditor } from "./union-sources-editor.tsx";

type Fact = PersonFactAlternative["field"];

const fieldName: Record<Fact, string> = {
  birth: "дата рождения",
  death: "дата смерти",
  birthPlace: "место рождения",
  deathPlace: "место смерти",
};

export function PersonAlternativeClaims({ kind, alternatives, savedIds, onChange,
  isAdmin, canAssess }: {
  kind: "birth" | "death";
  alternatives: PersonFactAlternative[];
  savedIds: ReadonlySet<string>;
  onChange: (alternatives: PersonFactAlternative[]) => void;
  isAdmin: boolean;
  canAssess: boolean;
}) {
  const visible = alternatives.filter((alternative) =>
    alternative.field === kind || alternative.field === `${kind}Place`);
  const update = (id: string, changes: Partial<PersonFactAlternative>) =>
    onChange(alternatives.map((alternative) => alternative.id === id
      ? { ...alternative, ...changes } : alternative));
  const add = (field: Fact) => onChange([...alternatives, {
    id: crypto.randomUUID(), field, value: "", sources: [],
  }]);
  return <details className="form-details fact-alternatives">
    <summary>Другие записи о {kind === "birth" ? "рождении" : "смерти"}
      {visible.length ? ` · ${visible.length}` : ""}</summary>
    <p>Если документы называют другую дату или место, сохраните каждый вариант с его источником.
      Основная дата и место останутся без изменений.</p>
    {visible.map((alternative) => {
      const isDate = alternative.field === "birth" || alternative.field === "death";
      const locked = savedIds.has(alternative.id);
      const mayRemove = canAssess || !alternative.confidence;
      return <section className="fact-alternative" key={alternative.id}>
        <label>
          Другая {fieldName[alternative.field]}
          <input
            value={isDate ? dateInputLabel(alternative.value) : alternative.value}
            readOnly={locked}
            required
            placeholder={isDate ? "Например, 1880 или 12.3.1880" : "Название в документе"}
            onChange={(event) => update(alternative.id, { value: event.target.value })}
            onBlur={() => {
              if (!isDate || locked || !alternative.value.trim()) return;
              try { update(alternative.id, { value: normalizeDateInput(alternative.value) }); }
              catch { /* Сервер и форма проверят дату при сохранении. */ }
            }}
          />
        </label>
        {locked && <small>Чтобы изменить сам вариант, удалите его и добавьте новую запись с нужным источником.</small>}
        <CitationSourcesEditor sources={alternative.sources}
          onChange={(sources) => update(alternative.id, { sources })}
          isAdmin={isAdmin} canRemoveLast={false} />
        <label>
          Достоверность
          <select value={alternative.confidence || ""} disabled={!canAssess}
            onChange={(event) => update(alternative.id, {
              confidence: event.target.value
                ? event.target.value as ClaimConfidence : undefined,
            })}>
            <option value="">Не оценено</option>
            {(Object.keys(CLAIM_CONFIDENCE_LABELS) as ClaimConfidence[]).map((status) =>
              <option key={status} value={status}>{CLAIM_CONFIDENCE_LABELS[status]}</option>)}
          </select>
        </label>
        <button type="button" disabled={!mayRemove} onClick={() =>
          onChange(alternatives.filter((item) => item.id !== alternative.id))}>
          Удалить вариант
        </button>
        {!mayRemove && <small>Оценённый вариант может удалить исследователь или администратор.</small>}
      </section>;
    })}
    <div className="fact-alternative-actions">
      <button type="button" onClick={() => add(kind)}>Добавить другую дату</button>
      <button type="button" onClick={() => add(`${kind}Place`)}>Добавить другое место</button>
    </div>
  </details>;
}
