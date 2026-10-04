import { useEffect, useState, type FormEvent } from "react";
import { archiveFetch } from "../data/archive-fetch";
import { ROLE_NAMES, type Role } from "../domain/access";
import type { StorageLimits } from "../shared/storage-limits";
import "../styles/storage-limits.css";

export function StorageLimitsAdmin() {
  const [saved, setSaved] = useState<StorageLimits | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const response = await archiveFetch("/api/settings/storage", {
          signal: request.signal,
        });
        if (!response.ok) throw new Error("Не удалось загрузить лимиты");
        const value = (await response.json()) as StorageLimits;
        if (!request.signal.aborted) {
          setSaved(value);
          setDraft(
            Object.fromEntries(
              Object.entries(value).map(([role, limit]) => [
                role,
                limit === null ? "" : String(limit),
              ]),
            ),
          );
        }
      } catch (reason) {
        if (!request.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить лимиты",
          );
      }
    })();
    return () => request.abort();
  }, [retry]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!saved || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = Object.fromEntries(
        Object.entries(draft).map(([role, limit]) => [
          role,
          limit.trim() === "" ? null : Number(limit),
        ]),
      );
      const response = await archiveFetch("/api/settings/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected: saved, next }),
      });
      const data = (await response.json()) as StorageLimits & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || "Не удалось сохранить лимиты");
      setSaved(data);
      setNotice("Лимиты сохранены");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить лимиты",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="storage-limits-form"
      onSubmit={(event) => void submit(event)}
      aria-label="Лимиты хранилища"
    >
      <p>
        Общий объём фотографий и документов для каждого участника этого архива. Лимит
        определяется его текущей ролью.
      </p>
      <div className="storage-limits-rows">
        {saved &&
          (Object.keys(ROLE_NAMES) as Role[]).map((role) => (
            <label key={role}>
              <span>{ROLE_NAMES[role]}</span>
              <input
                aria-label={`Лимит: ${ROLE_NAMES[role]}`}
                type="number"
                min={0}
                max={10240}
                step={1}
                placeholder="Без личного лимита"
                value={draft[role] ?? ""}
                disabled={busy}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    [role]: event.target.value,
                  }));
                  setNotice("");
                }}
              />
              <span>МБ</span>
            </label>
          ))}
      </div>
      <p className="field-hint">
        Пустое поле — без личного лимита, 0 — запрет новых загрузок. Один PDF —
        до 100 МБ, TIFF — до 50 МБ, изображение — до 20 МБ. Роль читателя по-прежнему не даёт права
        загрузки.
      </p>
      <p className="field-hint">
        Общая квота архива 10 ГиБ и ограничение базового аккаунта владельца 500
        МБ продолжают действовать. Снижение лимита не удаляет файлы. Вложения
        чатов ИИ учитываются отдельно.
      </p>
      {!saved && !error && <p role="status">Загружаем…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError("");
              setRetry((value) => value + 1);
            }}
          >
            Обновить лимиты
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        type="submit"
        className="primary-action"
        disabled={busy || !saved}
      >
        {busy ? "Сохраняем…" : "Сохранить лимиты"}
      </button>
    </form>
  );
}
