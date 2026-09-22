import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Bot, CheckCircle2, PlugZap, Save, TriangleAlert } from "lucide-react";

type AiAdminStatus = {
  enabled: boolean;
  active: boolean;
  configured: boolean;
  apiKeyConfigured: boolean;
  folderConfigured: boolean;
  model: string;
  modelOverride: string;
  modelSource: "database" | "environment" | "default";
  baseUrl: string;
};

export function AiSettingsAdmin() {
  const [status, setStatus] = useState<AiAdminStatus | null>(null),
    [enabled, setEnabled] = useState(true),
    [model, setModel] = useState(""),
    [busy, setBusy] = useState(false),
    [testing, setTesting] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");

  const applyStatus = useCallback((next: AiAdminStatus) => {
    setStatus(next);
    setEnabled(next.enabled);
    setModel(next.modelOverride || "");
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/ai", { cache: "no-store" }),
      data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Не удалось загрузить настройки AI Studio");
    applyStatus(data as AiAdminStatus);
  }, [applyStatus]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      void load().catch((reason) => {
        if (active) setError((reason as Error).message);
      });
    });
    return () => {
      active = false;
    };
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/ai", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled, model }),
        }),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось сохранить настройки AI Studio");
      applyStatus(data as AiAdminStatus);
      setNotice("Настройки AI Studio сохранены");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/ai/test", { method: "POST" }),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "AI Studio не ответила");
      setNotice(
        `Подключение работает · ${data.model}${data.answer ? ` · ${data.answer}` : ""}`,
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setTesting(false);
    }
  }

  if (!status && !error)
    return (
      <section className="admin-card archive-form ai-settings-admin">
        <h2>Yandex AI Studio</h2>
        <p role="status">Проверяем конфигурацию…</p>
      </section>
    );

  return (
    <section className="admin-card archive-form ai-settings-admin">
      <div className="ai-settings-title">
        <div>
          <Bot size={20} />
          <span>
            <h2>Yandex AI Studio</h2>
            <p>Модель встроенного ИИ-исследователя Drevo.</p>
          </span>
        </div>
        {status && (
          <span
            className={`ai-runtime-state ${status.active ? "is-active" : "is-inactive"}`}
          >
            {status.active ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
            {status.active
              ? "Работает"
              : status.configured
                ? "Выключен"
                : "Не настроен"}
          </span>
        )}
      </div>

      {status && (
        <>
          <div className="ai-config-status">
            <div>
              <b>API-ключ</b>
              <span>{status.apiKeyConfigured ? "Задан на сервере" : "Не задан"}</span>
            </div>
            <div>
              <b>Folder ID</b>
              <span>
                {status.folderConfigured
                  ? "Задан на сервере"
                  : status.model.startsWith("gpt://")
                    ? "Не требуется для полного URI"
                    : "Не задан"}
              </span>
            </div>
            <div>
              <b>Модель</b>
              <span>{status.model}</span>
            </div>
            <div>
              <b>Endpoint</b>
              <span>{status.baseUrl}</span>
            </div>
          </div>

          <form onSubmit={save}>
            <label
              className="setting-toggle"
              htmlFor="ai-research-enabled"
            >
              <span>
                <b>ИИ-исследователь</b>
                <small>
                  Отключение скрывает панель ИИ и блокирует новые запросы, но
                  не удаляет настройки и предложения.
                </small>
              </span>
              <input
                id="ai-research-enabled"
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
            </label>

            <label>
              Модель
              <input
                value={model}
                maxLength={300}
                placeholder={status.model}
                onChange={(event) => setModel(event.target.value)}
              />
              <small>
                Оставьте пустым, чтобы использовать YANDEX_AI_MODEL или
                yandexgpt/rc. Можно указать полный gpt:// URI.
              </small>
            </label>

            <footer className="ai-settings-actions">
              <button
                type="submit"
                className="primary-action"
                disabled={busy || testing}
              >
                <Save size={16} />
                {busy ? "Сохраняем…" : "Сохранить"}
              </button>
              <button
                type="button"
                disabled={busy || testing || !status.configured}
                onClick={() => void testConnection()}
              >
                <PlugZap size={16} />
                {testing ? "Проверяем…" : "Проверить подключение"}
              </button>
            </footer>
          </form>
        </>
      )}

      {notice && (
        <p className="admin-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
