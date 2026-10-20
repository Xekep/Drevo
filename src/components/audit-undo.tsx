import { useState } from "react";
import { Undo2 } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch.ts";
import type { AuditUndoPreview } from "../shared/personal-research.ts";
import { useListLimit } from "./load-more";

export function AuditUndo({
  revision,
  onApplied,
}: {
  revision: number;
  onApplied: () => void;
}) {
  const [preview, setPreview] = useState<AuditUndoPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const { limit, more } = useListLimit(String(revision));
  async function request(apply: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch(
        `/api/audit/transactions/${revision}/${apply ? "undo" : "preview"}`,
        {
          method: apply ? "POST" : "GET",
          ...(apply
            ? { headers: { "If-Match": String(preview?.currentRevision) } }
            : {}),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        if (apply) setPreview(null);
        throw new Error(data.error || "Не удалось проверить отмену");
      }
      if (apply) {
        setDone(true);
        setPreview(null);
        onApplied();
      } else setPreview(data);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (done)
    return (
      <p role="status">Операция отменена. Создана новая запись в истории.</p>
    );
  return (
    <div className="audit-undo">
      {!preview && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void request(false)}
        >
          <Undo2 size={15} />
          {busy ? "Проверяем…" : "Проверить отмену всей операции"}
        </button>
      )}
      {preview && (
        <div className="audit-undo-preview">
          <p>Вся операция · версия {preview.revision}</p>
          <ul>
            {preview.entries.slice(0, limit).map((entry, index) => (
              <li key={index}>
                {entry.action}: {entry.label}
              </li>
            ))}
          </ul>
          {preview.entries.length > limit && (
            <button type="button" onClick={more}>
              Показать ещё · всего {preview.entries.length}
            </button>
          )}
          {preview.reason && <p role="status">{preview.reason}</p>}
          <div className="form-actions">
            {preview.canUndo && (
              <button
                type="button"
                className="primary-action"
                disabled={busy}
                onClick={() => void request(true)}
              >
                {busy ? "Отменяем…" : "Отменить операцию"}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              Закрыть
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
