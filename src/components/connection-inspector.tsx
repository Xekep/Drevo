import { useState } from "react";
import { ArrowDownUp, Link2, X } from "lucide-react";
import {
  archiveConnections,
  canChangeConnection,
  connectPeople,
  replaceConnection,
  setParentClaim,
  removeConnection,
  CONNECTION_NAMES,
  connectionRoleName,
  fullName,
  suggestConnectionOrder,
  CLAIM_CONFIDENCE_LABELS,
  type Family,
  type ArchiveUser,
  type ClaimConfidence,
  type ConnectionType,
} from "../domain";
import { PersonSearch } from "./person-search";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";
import type { ConnectionDraft } from "./tree/tree-canvas";
import { FamilyUnionsPanel } from "./family-unions-panel";
import { CitationSourcesEditor } from "./union-sources-editor";
export function ConnectionInspector({
  family,
  user,
  draft,
  onChange,
  save,
  busy,
  onClose,
  onSaved,
  dirty = false,
  canEdit = true,
}: {
  family: Family;
  user: ArchiveUser | null;
  draft: ConnectionDraft;
  onChange: (draft: ConnectionDraft) => void;
  save: (family: Family) => Promise<Family>;
  busy: boolean;
  onClose: () => void;
  onSaved: () => void;
  dirty?: boolean;
  canEdit?: boolean;
}) {
  useUnsavedChanges(dirty);
  const [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false),
    [manualOrder, setManualOrder] = useState(false),
    [assessmentReset, setAssessmentReset] = useState(false);
  const canAssess = user?.role === "admin" || user?.role === "researcher";
  const readonly =
    !canEdit ||
    (!!draft.original && !canChangeConnection(family, user, draft.original));
  const people = [...family.people].sort((a, b) =>
    fullName(a).localeCompare(fullName(b), "ru"),
  );
  const from = people.find((p) => p.id === draft.from),
    to = people.find((p) => p.id === draft.to);
  const sourceRole = connectionRoleName(draft.type, from);
  const role = sourceRole.toLocaleLowerCase("ru");
  const roleLabel = sourceRole[0].toLocaleUpperCase("ru") + sourceRole.slice(1);
  const stepRole = connectionRoleName("step_parent", from);
  const stepRoleLabel = stepRole[0].toLocaleUpperCase("ru") + stepRole.slice(1);
  const targetRole = connectionRoleName(draft.type, to, "to");
  const targetRoleLabel =
    targetRole[0].toLocaleUpperCase("ru") + targetRole.slice(1);
  const changedAssertion = !!draft.original &&
    (draft.from !== draft.original.from || draft.to !== draft.original.to ||
      draft.type !== draft.original.type);
  const assessmentLocked = !!draft.original?.confidence && !canAssess;
  const saveIdentityFirst = !!draft.original?.confidence && changedAssertion;
  const update = (next: Partial<ConnectionDraft>) => {
    setError("");
    setConfirm(false);
    const assertionChanged = ["from", "to", "type"].some((key) =>
      key in next && next[key as "from" | "to" | "type"] !== draft[key as "from" | "to" | "type"]);
    const merged = { ...draft, hint: undefined, ...next,
      ...(assertionChanged ? { sources: [], confidence: undefined } : {}) };
    if (assertionChanged && draft.confidence) setAssessmentReset(true);
    onChange(
      !draft.original &&
        !manualOrder &&
        Object.keys(next).some((key) => ["from", "to", "type"].includes(key))
        ? suggestConnectionOrder(merged, people, family.links)
        : merged,
    );
  };
  async function submit(remove = false) {
    if (readonly) return;
    try {
      setError("");
      if (draft.original && !canChangeConnection(family, user, draft.original))
        throw new Error("Эту связь может изменить её автор или администратор.");
      if (!remove && !canChangeConnection(family, user, draft))
        throw new Error(
          "Нет прав менять выбранные карточки. Для кровной связи необходимо право на карточку ребёнка.",
        );
      let next =
        remove && draft.original
          ? removeConnection(family, draft.original)
          : draft.original
            ? replaceConnection(family, draft.original, draft)
            : connectPeople(
                family,
                draft.from,
                draft.to,
                draft.type,
                draft.note,
                draft.twinKind,
              );
      if (!remove && !draft.original && draft.type === "parent" &&
        (draft.sources?.length || draft.confidence))
        next = setParentClaim(next, draft.from, draft.to, draft.sources, draft.confidence);
      if (!remove && !draft.original && !["parent", "spouse"].includes(draft.type)) {
        if (draft.sources?.length) next.links!.at(-1)!.sources = draft.sources;
        if (draft.confidence) next.links!.at(-1)!.confidence = draft.confidence;
      }
      if (!remove && archiveConnections(next).length === 0)
        throw new Error("Связь не создана");
      await save(next);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (readonly)
    return (
      <section className="connection-inspector">
        <header className="inspector-heading">
          <span>
            <Link2 size={18} />
            Семейная связь
          </span>
          <button onClick={onClose} aria-label="Закрыть связь">
            <X size={20} />
          </button>
        </header>
        <div className="archive-form">
          <p className="connection-preview">
            {from ? fullName(from) : "Участник не выбран"} — <b>{role}</b> для{" "}
            {to ? fullName(to) : "второго человека"}.
          </p>
          {draft.note && <p>{draft.note}</p>}
          {!!draft.sources?.length && <p>Источники связи: {draft.sources.map((source) => source.title).join("; ")}</p>}
          {draft.confidence && <p>Оценка связи: {CLAIM_CONFIDENCE_LABELS[draft.confidence]}</p>}
          {draft.type === "twin" && (
            <p>
              Тип:{" "}
              {draft.twinKind === "identical"
                ? "однояйцевые"
                : draft.twinKind === "fraternal"
                  ? "разнояйцевые"
                  : "неизвестен"}
            </p>
          )}
        </div>
        {draft.type === "spouse" && from && to && <FamilyUnionsPanel family={family} participants={[from.id, to.id]} user={user} editable={false} save={save} busy={busy} onSaved={onSaved} />}
      </section>
    );
  return (
    <section className="connection-inspector">
      <header className="inspector-heading">
        <span>
          <Link2 size={18} />
          {draft.original ? "Семейная связь" : "Новая связь"}
        </span>
        <button onClick={onClose} disabled={busy} aria-label="Закрыть связь">
          <X size={20} />
        </button>
      </header>
      <form
        className="archive-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="connection-preview">
          {from && to ? (
            <>
              <b>{from.name}</b> — {role} для <b>{to.name}</b>.
            </>
          ) : (
            "Выберите участников и тип связи. Линия на дереве — предварительная."
          )}
        </p>
        <PersonSearch
          label={
            draft.type === "parent"
              ? "Родитель"
              : draft.type === "godparent"
                ? "Крёстный родитель"
                : draft.type === "step_parent"
                  ? roleLabel
                  : "Кто"
          }
          value={draft.from}
          selected={from}
          excludeId={draft.to}
          onChange={(id) => update({ from: id })}
          disabled={busy || assessmentLocked}
        />
        {draft.hint && (
          <p className="field-hint" role="status">
            {draft.hint}
          </p>
        )}
        <label>
          Кем приходится
          <select
            value={draft.type}
            disabled={readonly || busy || assessmentLocked}
            onChange={(e) => update({ type: e.target.value as ConnectionType })}
          >
            <optgroup label="Семья">
              {[
                "parent",
                "spouse",
                "godparent",
                "adoptive_parent",
                "foster_parent",
                "presumed_parent",
                "step_parent",
              ].map((type) => (
                <option key={type} value={type}>
                  {type === "step_parent"
                    ? stepRoleLabel
                    : CONNECTION_NAMES[type as ConnectionType]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Другие связи">
              {["guardian", "nurse", "sworn_sibling", "twin"].map((type) => (
                <option key={type} value={type}>
                  {CONNECTION_NAMES[type as ConnectionType]}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        {draft.type === "twin" && (
          <label>
            Тип близнецов
            <select
              value={draft.twinKind || "unknown"}
              disabled={readonly || busy}
              onChange={(e) =>
                update({
                  twinKind: e.target.value as
                    "unknown" | "identical" | "fraternal",
                })
              }
            >
              <option value="unknown">Неизвестен</option>
              <option value="identical">Однояйцевые</option>
              <option value="fraternal">Разнояйцевые</option>
            </select>
          </label>
        )}
        <PersonSearch
          label={
            draft.type === "parent"
              ? "Ребёнок"
              : draft.type === "godparent"
                ? "Крестник / крестница"
                : draft.type === "step_parent"
                  ? targetRoleLabel
                  : "С кем связан"
          }
          value={draft.to}
          selected={to}
          excludeId={draft.from}
          onChange={(id) => update({ to: id })}
          disabled={busy || assessmentLocked}
        />
        {!readonly && (
          <button
            type="button"
            className="icon-button connection-swap"
            aria-label="Поменять участников местами"
            title="Поменять участников местами"
            disabled={busy || assessmentLocked}
            onClick={() => {
              setManualOrder(true);
              setError("");
              setConfirm(false);
              if (draft.confidence) setAssessmentReset(true);
              onChange({
                ...draft,
                hint: undefined,
                from: draft.to,
                to: draft.from,
                sources: [],
                confidence: undefined,
              });
            }}
          >
            <ArrowDownUp size={16} />
          </button>
        )}
        {!["parent", "spouse"].includes(draft.type) && (
          <label>
            Примечание
            <textarea
              rows={3}
              disabled={readonly || busy}
              value={draft.note || ""}
              onChange={(e) => update({ note: e.target.value })}
            />
          </label>
        )}
        {draft.type !== "spouse" && (
          saveIdentityFirst
            ? <p>Сначала сохраните новую связь, затем оцените её заново.</p>
            : <label>
                Статус достоверности связи
                <select value={draft.confidence || ""} disabled={!canAssess || busy}
                  onChange={(event) => update({ confidence: event.target.value
                    ? event.target.value as ClaimConfidence : undefined })}>
                  <option value="">Оценка не задана</option>
                  {(Object.keys(CLAIM_CONFIDENCE_LABELS) as ClaimConfidence[]).map((status) =>
                    <option key={status} value={status}>{CLAIM_CONFIDENCE_LABELS[status]}</option>)}
                </select>
              </label>
        )}
        {assessmentReset && <p role="status">Прежняя оценка связи снята из черновика. После сохранения оцените новую связь заново.</p>}
        {draft.type !== "spouse" && (
          <details className="union-milestone-sources">
            <summary>Источники связи ({draft.sources?.length || 0})</summary>
            {changedAssertion &&
              <small>После смены участников или типа прежние источники нужно привязать заново.</small>}
            {!changedAssertion && <CitationSourcesEditor sources={draft.sources || []}
              isAdmin={user?.role === "admin"}
              onChange={(sources) => update({ sources })} />}
          </details>
        )}
        <p>
          Братья, сёстры и более дальнее родство рассчитываются автоматически по
          родителям и бракам. Связь сохранится только после подтверждения.
        </p>
        {readonly && (
          <p>
            Доступен просмотр. Изменять эту связь может её автор или
            администратор.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!readonly && (
          <footer>
            <button
              className="primary-action"
              disabled={busy || !draft.from || !draft.to}
            >
              {busy ? "Сохраняем…" : "Сохранить связь"}
            </button>
            {draft.original && (
              <button
                type="button"
                disabled={busy || assessmentLocked}
                className="danger-action"
                onClick={() => (confirm ? void submit(true) : setConfirm(true))}
              >
                {confirm ? "Подтвердить удаление" : "Убрать связь"}
              </button>
            )}
          </footer>
        )}
        {assessmentLocked && <p>Оценённую связь может удалить или изменить по участникам и типу только исследователь или администратор.</p>}
      </form>
      {draft.type === "spouse" && draft.original && from && to && <FamilyUnionsPanel family={family} participants={[from.id, to.id]} user={user} editable={canEdit} save={save} busy={busy} onSaved={onSaved} />}
    </section>
  );
}
