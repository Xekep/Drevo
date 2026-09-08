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
  type Family,
  type ArchiveUser,
  type ConnectionType,
} from "../domain";
import type { ConnectionDraft } from "./tree/tree-canvas";
export function ConnectionInspector({
  family,
  user,
  draft,
  onChange,
  save,
  busy,
  onClose,
}: {
  family: Family;
  user: ArchiveUser | null;
  draft: ConnectionDraft;
  onChange: (draft: ConnectionDraft) => void;
  save: (family: Family) => Promise<Family>;
  busy: boolean;
  onClose: () => void;
}) {
  const [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const readonly =
    !!draft.original && !canChangeConnection(family, user, draft.original);
  const people = [...family.people].sort((a, b) =>
    fullName(a).localeCompare(fullName(b), "ru"),
  );
  const from = people.find((p) => p.id === draft.from),
    to = people.find((p) => p.id === draft.to);
  const update = (next: Partial<ConnectionDraft>) => {
    setError("");
    setConfirm(false);
    onChange({ ...draft, ...next });
  };
  async function submit(remove = false) {
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
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
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
              <b>{from.name}</b> —{" "}
              {CONNECTION_NAMES[draft.type].toLocaleLowerCase("ru")} для{" "}
              <b>{to.name}</b>.
            </>
          ) : (
            "Выберите участников и тип связи. Линия на дереве — предварительная."
          )}
        </p>
        <label>
          Первый человек
          <select
            required
            value={draft.from}
            disabled={readonly || busy}
            onChange={(e) => update({ from: e.target.value })}
          >
            <option value="">Выберите человека</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {fullName(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Кем приходится
          <select
            value={draft.type}
            disabled={readonly || busy}
            onChange={(e) => update({ type: e.target.value as ConnectionType })}
          >
            <optgroup label="Семья">
              {["parent", "spouse", "adoptive_parent"].map((type) => (
                <option key={type} value={type}>
                  {CONNECTION_NAMES[type as ConnectionType]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Другие связи">
              {["godparent", "guardian", "nurse", "sworn_sibling"].map(
                (type) => (
                  <option key={type} value={type}>
                    {CONNECTION_NAMES[type as ConnectionType]}
                  </option>
                ),
              )}
            </optgroup>
          </select>
        </label>
        <label>
          Второй человек
          <select
            required
            value={draft.to}
            disabled={readonly || busy}
            onChange={(e) => update({ to: e.target.value })}
          >
            <option value="">Выберите человека</option>
            {people
              .filter((p) => p.id !== draft.from)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {fullName(p)}
                </option>
              ))}
          </select>
        </label>
        {!readonly && (
          <button
            type="button"
            disabled={busy}
            onClick={() => update({ from: draft.to, to: draft.from })}
          >
            <ArrowDownUp size={16} />
            Поменять местами
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
          Братья, сёстры и более дальнее родство рассчитываются по родителям и
          бракам.
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
