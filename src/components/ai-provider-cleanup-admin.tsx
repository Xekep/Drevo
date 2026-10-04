import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch.ts";
import type {
  AiCleanupFailure,
  AiCleanupFilter,
  AiCleanupState,
  AiCleanupStatus,
} from "../shared/ai-provider-cleanup-status.ts";

const stateLabels: Record<AiCleanupState, string> = {
  binding: "Ожидает завершения",
  pending: "Ожидает очистки",
  leased: "В работе",
  blocked: "Нужны действия",
};
const errors: Record<AiCleanupFailure, string> = {
  snapshot_invalid:
    "Повреждены данные подключения. Проверьте системное восстановление",
  provider_auth: "Проверьте права исходного подключения",
  provider_rejected: "Провайдер отклонил удаление",
  provider_temporary:
    "Временная ошибка провайдера; попытка повторится автоматически",
  provider_network: "Нет ответа провайдера; попытка повторится автоматически",
  unknown: "Неизвестная ошибка очистки",
};
const date = (value: number) =>
  new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Owns only the lazy operational listing, independently of the settings draft. */
export function AiProviderCleanupAdmin({ archiveId = null }: { archiveId?: string | null }) {
  const url = (path: string) => archiveId ? `/a/${archiveId}${path}` : path;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<AiCleanupFilter>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState<AiCleanupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState("");
  const [retryError, setRetryError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      setError("");
      const query = new URLSearchParams({ filter });
      if (cursor) query.set("cursor", cursor);
      void archiveFetch(url(`/api/admin/ai/cleanup?${query}`), {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok)
            throw new Error(body.error || "Не удалось загрузить очередь");
          if (!controller.signal.aborted) setStatus(body as AiCleanupStatus);
        })
        .catch((reason) => {
          if (!controller.signal.aborted) {
            setStatus(null);
            setError(
              reason instanceof Error
                ? reason.message
                : "Не удалось загрузить очередь",
            );
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    });
    return () => controller.abort();
  }, [open, filter, cursor, reload]);
  const refresh = () => {
    setCursor(null);
    setHistory([]);
    setReload((value) => value + 1);
  };
  const retry = async (id: string) => {
    if (retryingId) return;
    setRetryingId(id);
    setRetryMessage("");
    setRetryError("");
    try {
      const response = await archiveFetch(url(`/api/admin/ai/cleanup/${id}/retry`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Не удалось поставить повтор в очередь");
      setRetryMessage("Поставлено в очередь. Удаление у провайдера ещё не подтверждено.");
      refresh();
    } catch (reason) {
      setRetryError(reason instanceof Error ? reason.message :
        "Не удалось поставить повтор в очередь");
    } finally {
      setRetryingId(null);
    }
  };
  return (
    <details
      className="ai-admin-connection ai-cleanup-admin"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Очистка диалогов у провайдера</summary>
      {open && (
        <section aria-label="Очередь очистки ИИ" aria-busy={loading}>
          <div className="ai-cleanup-toolbar">
            <label>
              Показать{" "}
              <select
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value as AiCleanupFilter);
                  setCursor(null);
                  setHistory([]);
                  setStatus(null);
                }}
              >
                <option value="all">Все незавершённые</option>
                <option value="blocked">Нужны действия</option>
              </select>
            </label>
            <button type="button" disabled={loading} onClick={refresh}>
              <RefreshCw size={14} /> Обновить очередь
            </button>
          </div>
          {loading && <p role="status">Загружаем очередь…</p>}
          {error && <p role="alert">{error}</p>}
          {retryError && <p role="alert">{retryError}</p>}
          {retryMessage && <p role="status">{retryMessage}</p>}
          {status && !status.supported && (
            <p>
              Долговечная очередь доступна при PostgreSQL. В этом режиме
              удаление у провайдера выполняется однократно.
            </p>
          )}
          {status?.supported && (
            <>
              <p className="ai-cleanup-counts">
                Вся платформа · ожидают{" "}
                {status.counts.pending + status.counts.binding}
                {" · "}в работе {status.counts.leased}
                {" · "}нужны действия {status.counts.blocked}
              </p>
              {!status.jobs.length && !loading && (
                <p>
                  {filter === "blocked"
                    ? "Заблокированных попыток нет"
                    : "Незавершённых попыток нет"}
                </p>
              )}
              <ol className="ai-cleanup-jobs">
                {status.jobs.map((job) => (
                  <li key={job.id}>
                    <div>
                      <strong
                        className={job.state === "blocked" ? "is-blocked" : ""}
                      >
                        {stateLabels[job.state]}
                      </strong>
                      <small title={job.id}>
                        Задание {job.id.slice(0, 8)} · попыток {job.attempts}
                      </small>
                    </div>
                    <time dateTime={new Date(job.updatedAt).toISOString()}>
                      {date(job.updatedAt)}
                    </time>
                    {job.error && (
                      <p>
                        {errors[job.error]}
                        {job.httpStatus ? ` (HTTP ${job.httpStatus})` : ""}
                      </p>
                    )}
                    {job.nextAttemptAt !== null && job.state !== "leased" && (
                      <small>
                        {job.nextAttemptAt <= status.checkedAt
                          ? "При следующей проверке очереди"
                          : `Следующая проверка: ${date(job.nextAttemptAt)}`}
                      </small>
                    )}
                    {job.canRetry && (
                      <button type="button" disabled={retryingId !== null}
                        onClick={() => void retry(job.id)}>
                        {retryingId === job.id ? "Ставим в очередь…" : "Повторить"}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              <nav aria-label="Страницы очереди очистки">
                <button
                  type="button"
                  disabled={loading || !history.length}
                  onClick={() => {
                    setCursor(history.at(-1) ?? null);
                    setHistory((items) => items.slice(0, -1));
                  }}
                >
                  Назад
                </button>
                <span>Страница {history.length + 1}</span>
                <button
                  type="button"
                  disabled={loading || !status.nextCursor}
                  onClick={() => {
                    setHistory((items) => [...items, cursor]);
                    setCursor(status.nextCursor);
                  }}
                >
                  Далее
                </button>
              </nav>
              <small>
                Временные ошибки повторяются автоматически. Новый API-ключ в
                настройках не заменяет исходное подключение сохранённых заданий.
                Удаление диалога не подтверждает удаления его отдельных
                сообщений у провайдера.
              </small>
            </>
          )}
        </section>
      )}
    </details>
  );
}
