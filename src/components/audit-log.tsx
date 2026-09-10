import { useEffect, useState } from "react";
import type { AuditEntry } from "../domain/audit";
export function AuditLog({
  personId,
  actorId,
}: {
  personId?: string;
  actorId?: string;
}) {
  const [items, setItems] = useState<AuditEntry[]>([]),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true);
  const endpoint = `/api/audit?${new URLSearchParams({ ...(personId ? { personId } : {}), ...(actorId ? { actorId } : {}) })}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        setItems(data.items);
        setNext(data.next);
        setBusy(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setBusy(false);
        }
      });
    return () => controller.abort();
  }, [endpoint]);
  async function more() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${endpoint}&before=${next}`),
        data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setItems((old) => [...old, ...data.items]);
      setNext(data.next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="audit-log">
      {!items.length && !busy && !error && (
        <p className="muted-copy">
          Правок пока нет. Журнал записывает изменения с момента включения этой
          функции.
        </p>
      )}
      {items.map((entry) => (
        <details className="audit-entry" key={entry.id}>
          <summary>
            <span>
              <strong>
                {entry.action}: {entry.label}
              </strong>
              <small>
                {entry.actorName} · {new Date(entry.at).toLocaleString("ru-RU")}
              </small>
            </span>
          </summary>
          {!!entry.details.length && (
            <div className="audit-diff">
              {entry.details.map((d, i) => (
                <div className="audit-field" key={i}>
                  <b>{d.field}</b>
                  <div>
                    <span>
                      <small>Было</small>
                      {d.before || "Не указано"}
                    </span>
                    <span>
                      <small>Стало</small>
                      {d.after || "Не указано"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </details>
      ))}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {busy && <p role="status">Загружаем историю…</p>}
      {next !== null && (
        <button disabled={busy} onClick={() => void more()}>
          Показать ещё
        </button>
      )}
    </div>
  );
}
