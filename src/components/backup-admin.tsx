import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import { useEffect, useState } from "react";
import {
  DatabaseBackup,
  Download,
  HardDrive,
  LoaderCircle,
  RotateCcw,
  Server,
} from "lucide-react";
import type {
  BackupJob,
  BackupSettings,
  BackupStatus,
} from "../shared/backup-management";
import { BackupRestore } from "./backup-restore";

async function request(archiveId: string | null, path: string, method = "GET", body?: unknown) {
  const response = await archiveFetch(archiveResourceUrl("/api/backups" + path,
    archiveId ? `/a/${archiveId}` : "/"), {
    method,
    headers: { "Content-Type": "application/json", "X-Drevo-Backup": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Не удалось выполнить операцию.");
  return result;
}
const date = (value: string) =>
  new Date(value).toLocaleString("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
const bytes = (value: number) =>
  value >= 1024 ** 3
    ? (value / 1024 ** 3).toFixed(1) + " ГиБ"
    : Math.max(0.1, value / 1024 ** 2).toFixed(1) + " МиБ";

export function BackupAdmin({ archiveId }: { archiveId: string | null }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [draft, setDraft] = useState<BackupSettings | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [prepareComments, setPrepareComments] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      let delay = 15000;
      try {
        const response = await archiveFetch(archiveResourceUrl("/api/backups/?offset=" + offset,
          archiveId ? `/a/${archiveId}` : "/"), {
          signal: controller.signal,
        });
        const data = (await response.json()) as BackupStatus & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || "Не удалось загрузить копии.");
        if (active) {
          setStatus(data);
          setDraft((previous) => previous || data.settings);
          if (data.job?.state === "running") delay = 1500;
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
      if (active) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [archiveId, offset, refresh]);

  const running = busy || status?.job?.state === "running";
  const dirty =
    !!draft && JSON.stringify(draft) !== JSON.stringify(status?.settings);
  const preview =
    status?.job?.id === previewJobId ? status.job.preview : undefined;
  function field<K extends keyof BackupSettings>(
    key: K,
    value: BackupSettings[K],
  ) {
    setDraft((current) => (current ? { ...current, [key]: value } : null));
    setNotice("");
  }
  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const job = (await request(archiveId, path, "POST", body)) as BackupJob;
      if (path.endsWith("/preview")) setPreviewJobId(job.id);
      setStatus((current) => (current ? { ...current, job } : current));
      setRefresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = (await request(
        archiveId,
        "/settings",
        "PUT",
        draft,
      )) as BackupSettings;
      setDraft(saved);
      setStatus((current) =>
        current ? { ...current, settings: saved } : current,
      );
      setNotice("Настройки сохранены.");
      setRefresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!status || !draft)
    return (
      <section className="admin-card" aria-busy={!error}>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : (
          <p role="status">Загружаем резервные копии…</p>
        )}
        {error && (
          <button
            onClick={() => {
              setError("");
              setRefresh((v) => v + 1);
            }}
          >
            Повторить
          </button>
        )}
      </section>
    );
  return (
    <div className="backup-admin">
      <section className="admin-card archive-form">
        <form
          onSubmit={(event) => void save(event)}
          className="backup-settings"
        >
          <div className="backup-heading">
            <h2>Автоматические копии</h2>
            <label className="backup-toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={running}
                onChange={(e) => field("enabled", e.target.checked)}
              />
              Включены
            </label>
          </div>
          <div className="backup-fields">
            <div className="backup-interval-field">
              <label htmlFor="backup-interval">Как часто</label>
              <select
                id="backup-interval"
                value={
                  [12, 24, 168].includes(draft.intervalHours)
                    ? draft.intervalHours
                    : "custom"
                }
                disabled={running}
                onChange={(e) =>
                  field(
                    "intervalHours",
                    e.target.value === "custom" ? 48 : Number(e.target.value),
                  )
                }
              >
                <option value={12}>Каждые 12 часов</option>
                <option value={24}>Ежедневно</option>
                <option value={168}>Еженедельно</option>
                <option value="custom">Свой интервал</option>
              </select>
              {![12, 24, 168].includes(draft.intervalHours) && (
                <label>
                  Период, часов
                  <input
                    type="number"
                    min={1}
                    max={720}
                    required
                    value={draft.intervalHours}
                    disabled={running}
                    onChange={(e) =>
                      field("intervalHours", Number(e.target.value))
                    }
                  />
                </label>
              )}
            </div>
            <label>
              Количество копий
              <input
                type="number"
                min={1}
                max={365}
                required
                value={draft.keepCount}
                disabled={running}
                onChange={(e) => field("keepCount", Number(e.target.value))}
              />
              <small>Старые удаляются после создания новой</small>
            </label>
          </div>
          <label>
            Хранилище
            <select
              aria-label="Хранилище"
              value={draft.storage}
              disabled={running}
              onChange={(e) =>
                field("storage", e.target.value as BackupSettings["storage"])
              }
            >
              <option value="local">Локально, на сервере архива</option>
              <option value="remote">Отдельный сервер по SSH</option>
            </select>
          </label>
          {draft.storage === "local" ? (
            <details className="backup-location">
              <summary>Локально на сервере архива · показать путь</summary>
              <code>{status.localDirectory}</code>
            </details>
          ) : (
            <>
              <div className="backup-fields">
                <label>
                  SSH-подключение
                  <input
                    required
                    placeholder="backup-vault"
                    value={draft.remoteHost}
                    maxLength={64}
                    disabled={running}
                    onChange={(e) => field("remoteHost", e.target.value)}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Каталог на сервере
                  <input
                    required
                    placeholder="/srv/backups/drevo"
                    value={draft.remoteDirectory}
                    maxLength={241}
                    disabled={running}
                    onChange={(e) => field("remoteDirectory", e.target.value)}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
              </div>
              <details className="backup-connection-help">
                <summary>Как подключить сервер</summary>
                <p>
                  Администратор сервера один раз настраивает SSH-подключение в{" "}
                  <code>{status.sshConfig}</code>: адрес, порт, пользователя,
                  приватный ключ и проверенный ключ сервера. Здесь укажите его
                  имя (например, backup-vault) и каталог. На отдельном сервере
                  нужны SFTP и Python 3.8+.
                </p>
                <p>
                  Пароли и ключи не передаются через эту форму. При смене
                  хранилища прежние копии остаются доступны по старому
                  подключению.
                </p>
              </details>
              <button
                type="button"
                disabled={running}
                onClick={() => void act("/check", draft)}
              >
                Проверить подключение
              </button>
            </>
          )}
          <div className="backup-settings-footer">
            <button
              type="submit"
              className="primary-action"
              disabled={running || !dirty}
            >
              Сохранить настройки
            </button>
            <small>
              {status.nextRunAt
                ? "Следующая копия: " + date(status.nextRunAt)
                : "Автоматическое копирование выключено"}
            </small>
          </div>
        </form>
      </section>
      <section className="admin-card archive-form">
        <div className="backup-heading">
          <div>
            <h2>Сохранённые копии</h2>
            <p>База, фотографии, документы и ключ настроек.</p>
          </div>
          <button
            type="button"
            className="primary-action"
            disabled={running || dirty}
            onClick={() => void act("/create")}
          >
            <DatabaseBackup size={17} aria-hidden="true" />
            Создать копию
          </button>
        </div>
        {dirty && <small>Сохраните настройки перед созданием копии.</small>}
        {status.job && (
          <p
            className={"backup-job " + status.job.state}
            role={status.job.state === "failed" ? "alert" : "status"}
          >
            {status.job.state === "running" && (
              <LoaderCircle
                size={17}
                className="backup-spinner"
                aria-hidden="true"
              />
            )}
            {status.job.state === "running"
              ? status.job.kind === "create"
                ? "Создаём копию. Можно закрыть этот раздел."
                : status.job.kind === "preview"
                  ? "Проверяем копию для восстановления…"
                  : "Проверяем подключение…"
              : status.job.state === "failed"
                ? status.job.error
                : status.job.warning ||
                  (status.job.kind === "create"
                    ? "Резервная копия создана."
                    : status.job.kind === "check"
                      ? "Соединение установлено, запись в каталог доступна."
                      : "Копия проверена. Для замены данных требуется подтверждение.")}
          </p>
        )}
        <label className="restore-confirm">
          <input type="checkbox" checked={prepareComments} disabled={running}
            onChange={(event) => setPrepareComments(event.target.checked)} />
          При проверке копии подготовить восстановление комментариев и вложений
        </label>
        <ul className="backup-list" aria-label="Резервные копии">
          {status.records.map((item) => (
            <li key={item.id}>
              <span className="backup-list-icon" aria-hidden="true">
                {item.storage === "local" ? (
                  <HardDrive size={19} />
                ) : (
                  <Server size={19} />
                )}
              </span>
              <div className="backup-list-info">
                <b>{date(item.createdAt)}</b>
                <small>
                  {bytes(item.size)} ·{" "}
                  {item.storage === "local"
                    ? "На сервере архива"
                    : item.remoteHost}
                </small>
              </div>
              <div className="backup-list-actions">
                <a
                  href={archiveResourceUrl("/api/backups/" + item.id + "/download",
                    archiveId ? `/a/${archiveId}` : "/")}
                  download
                  aria-label={"Скачать копию от " + date(item.createdAt)}
                  title="Скачать"
                >
                  <Download size={17} />
                </a>
                <button
                  type="button"
                  disabled={running}
                  onClick={() => void act("/" + item.id + "/preview",
                    { restoreComments: prepareComments })}
                  aria-label={"Восстановить копию от " + date(item.createdAt)}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  Восстановить
                </button>
              </div>
            </li>
          ))}
        </ul>
        {!status.total && (
          <p className="backup-empty">
            Копий пока нет. Создайте первую или дождитесь запуска по расписанию.
          </p>
        )}
        {status.total > 20 && (
          <nav
            className="backup-pagination"
            aria-label="Страницы резервных копий"
          >
            <button
              disabled={offset === 0}
              onClick={() => setOffset((v) => Math.max(0, v - 20))}
            >
              Назад
            </button>
            <span>
              {Math.min(offset + 1, status.total)}–
              {Math.min(offset + 20, status.total)} из {status.total}
            </span>
            <button
              disabled={offset + 20 >= status.total}
              onClick={() => setOffset((v) => v + 20)}
            >
              Далее
            </button>
          </nav>
        )}
        {preview && (
          <BackupRestore
            key={preview.token}
            archiveId={archiveId}
            initialPreview={preview}
            onCancel={() => setPreviewJobId(null)}
            onRestored={() => {
              setPreviewJobId(null);
              setNotice("Архив восстановлен. Данные обновлены.");
              setRefresh((value) => value + 1);
            }}
          />
        )}
      </section>
      <section className="admin-card archive-form">
        <details>
          <summary>Восстановить из файла на компьютере</summary>
          <BackupRestore archiveId={archiveId} onRestored={() => {
            setNotice("Архив восстановлен. Данные обновлены.");
            setRefresh((value) => value + 1);
          }} />
        </details>
      </section>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="admin-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
