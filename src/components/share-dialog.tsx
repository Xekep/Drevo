import { useState } from "react";
import { Copy, Link2 } from "lucide-react";
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
  const [title, setTitle] = useState(`Семья: ${anchor.name} ${anchor.surname}`),
    [hours, setHours] = useState(168),
    [url, setUrl] = useState(""),
    [expires, setExpires] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/shares", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(revision),
        },
        body: JSON.stringify({
          anchorId: anchor.id,
          personIds: people.map((p) => p.id),
          durationHours: hours,
          title,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setUrl(new URL(data.path, location.origin).href);
      setExpires(data.share.expiresAt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <EditorDialog
      title="Поделиться семьёй"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="archive-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        {!url ? (
          <>
            <p>
              Просмотр без входа: {people.length} человек, их карточки и
              портреты. Состав ссылки останется таким же; сведения в карточках
              будут обновляться.
            </p>
            <label>
              Название
              <input
                value={title}
                maxLength={200}
                required
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Срок действия
              <select
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              >
                <option value={1}>1 час</option>
                <option value={24}>1 день</option>
                <option value={168}>7 дней</option>
                <option value={720}>30 дней</option>
              </select>
            </label>
            <details className="share-members">
              <summary>Кто будет виден · {people.length}</summary>
              <ul>
                {people.map((p) => (
                  <li key={p.id}>{fullName(p)}</li>
                ))}
              </ul>
            </details>
            <p className="field-hint">
              Альбомы и остальная часть архива по этой ссылке недоступны.
              Отозвать её можно в админке.
            </p>
            <button className="primary-action" disabled={busy}>
              <Link2 size={16} />
              {busy ? "Создаём…" : "Создать ссылку"}
            </button>
          </>
        ) : (
          <>
            <p>Действует до {new Date(expires).toLocaleString("ru-RU")}</p>
            <label>
              Ссылка
              <input readOnly value={url} onFocus={(e) => e.target.select()} />
            </label>
            <button
              type="button"
              className="primary-action"
              onClick={() => {
                void navigator.clipboard
                  .writeText(url)
                  .then(() => setCopied(true))
                  .catch(() =>
                    setError("Выделите и скопируйте ссылку из поля."),
                  );
              }}
            >
              <Copy size={16} />
              {copied ? "Скопировано" : "Скопировать"}
            </button>
            <p className="field-hint">
              Сохраните ссылку сейчас: в каталоге останутся её описание, автор и
              срок, а секретный адрес повторно не показывается.
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </EditorDialog>
  );
}
