import { useState } from "react";
import { ArrowDownUp, Link2, X } from "lucide-react";
import {
  archiveConnections,
  canChangeConnection,
  connectPeople,
  replaceConnection,
  removeConnection,
  CONNECTION_NAMES,
  fullName,
  resolvedSex,
  suggestConnectionOrder,
  type Family,
  type ArchiveUser,
  type ConnectionType,
} from "../domain";
import { PersonSearch } from "./person-search";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";
import type { ConnectionDraft } from "./tree/tree-canvas";
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
    [manualOrder, setManualOrder] = useState(false);
  const readonly =
    !canEdit ||
    (!!draft.original && !canChangeConnection(family, user, draft.original));
  const people = [...family.people].sort((a, b) =>
    fullName(a).localeCompare(fullName(b), "ru"),
  );
  const from = people.find((p) => p.id === draft.from),
    to = people.find((p) => p.id === draft.to);
  const sex = from ? resolvedSex(from) : "u";
  const role =
    draft.type === "parent"
      ? sex === "m"
        ? "отец"
        : sex === "f"
          ? "мать"
          : "родитель"
      : draft.type === "godparent"
        ? sex === "m"
          ? "крёстный отец"
          : sex === "f"
            ? "крёстная мать"
            : "крёстный родитель"
        : CONNECTION_NAMES[draft.type].toLocaleLowerCase("ru");
  const update = (next: Partial<ConnectionDraft>) => {
    setError("");
    setConfirm(false);
    const merged = { ...draft, hint: undefined, ...next };
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
      const next =
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
              );
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
        </div>
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
                : "Кто"
          }
          value={draft.from}
          selected={from}
          excludeId={draft.to}
          onChange={(id) => update({ from: id })}
          disabled={busy}
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
            disabled={readonly || busy}
            onChange={(e) => update({ type: e.target.value as ConnectionType })}
          >
            <optgroup label="Семья">
              {["parent", "spouse", "godparent", "adoptive_parent"].map(
                (type) => (
                  <option key={type} value={type}>
                    {CONNECTION_NAMES[type as ConnectionType]}
                  </option>
                ),
              )}
            </optgroup>
            <optgroup label="Другие связи">
              {["guardian", "nurse", "sworn_sibling"].map((type) => (
                <option key={type} value={type}>
                  {CONNECTION_NAMES[type as ConnectionType]}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <PersonSearch
          label={
            draft.type === "parent"
              ? "Ребёнок"
              : draft.type === "godparent"
                ? "Крестник / крестница"
                : "С кем связан"
          }
          value={draft.to}
          selected={to}
          excludeId={draft.from}
          onChange={(id) => update({ to: id })}
          disabled={busy}
        />
        {!readonly && (
          <button
            type="button"
            className="icon-button connection-swap"
            aria-label="Поменять участников местами"
            title="Поменять участников местами"
            disabled={busy}
            onClick={() => {
              setManualOrder(true);
              setError("");
              setConfirm(false);
              onChange({
                ...draft,
                hint: undefined,
                from: draft.to,
                to: draft.from,
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
                disabled={busy}
                className="danger-action"
                onClick={() => (confirm ? void submit(true) : setConfirm(true))}
              >
                {confirm ? "Подтвердить удаление" : "Убрать связь"}
              </button>
            )}
          </footer>
        )}
      </form>
    </section>
  );
}
