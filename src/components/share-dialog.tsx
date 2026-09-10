import { useState } from "react";
import { Copy, Link2, Check } from "lucide-react";
import { EditorDialog } from "./editor-dialog";
import { fullName } from "../domain/dates";
import type { Person } from "../domain/types";
export function ShareDialog({
  anchor,
  people,
  revision,
  onClose,
}: {
  anchor: Person;
  people: Person[];
  revision: number;
  onClose: () => void;
}) {
  const [hours, setHours] = useState(168),
    [url, setUrl] = useState(""),
    [expires, setExpires] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setError("");
    } catch {
      setCopied(false);
      setError(
        "Не удалось скопировать автоматически. Выделите ссылку в поле ниже.",
      );
    }
  }
  async function createAndCopy() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (url) {
        await copy(url);
        return;
      }
      const response = await fetch("/api/shares", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(revision),
        },
        body: JSON.stringify({
          anchorId: anchor.id,
          personIds: people.map((p) => p.id),
          durationHours: hours,
          title: `Семья: ${anchor.name} ${anchor.surname}`.slice(0, 200),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const address = new URL(data.path, location.origin).href;
      setUrl(address);
      setExpires(data.share.expiresAt);
      await copy(address);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <EditorDialog
      title="Поделиться семьёй"
      className="share-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="archive-form"
        onSubmit={(e) => {
          e.preventDefault();
          void createAndCopy();
        }}
      >
        <details className="share-members">
          <summary>{people.length} человек · просмотр без входа</summary>
          <ul>
            {people.map((person) => (
              <li key={person.id}>{fullName(person)}</li>
            ))}
          </ul>
        </details>
        <label>
          Срок действия
          <select
            value={hours}
            disabled={busy || !!url}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            <option value={1}>1 час</option>
            <option value={24}>1 день</option>
            <option value={168}>7 дней</option>
            <option value={720}>30 дней</option>
          </select>
        </label>
        <p className="field-hint">
          Только выбранная семья. Ссылку можно отозвать в админке.
        </p>
        <button className="primary-action" disabled={busy}>
          {copied ? (
            <Check size={16} />
          ) : url ? (
            <Copy size={16} />
          ) : (
            <Link2 size={16} />
          )}
          {busy
            ? "Подготавливаем…"
            : url
              ? "Скопировать ссылку"
              : "Создать и скопировать"}
        </button>
        {url && (
          <p className="share-result" role="status">
            {copied ? "Ссылка скопирована. " : "Ссылка создана. "}Действует до{" "}
            {new Date(expires).toLocaleString("ru-RU")}.
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {url && !copied && (
          <label>
            Ссылка
            <input readOnly value={url} onFocus={(e) => e.target.select()} />
          </label>
        )}
      </form>
    </EditorDialog>
  );
}
