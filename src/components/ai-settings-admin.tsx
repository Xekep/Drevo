import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Bot,
  CheckCircle2,
  PlugZap,
  RefreshCw,
  Save,
  TriangleAlert,
} from "lucide-react";
import { AiTokenUsageChart } from "./charts/ai-token-usage-chart";
import { AiRoleProfilesEditor } from "./ai-role-profiles-editor";
import {
  inheritedAiRoleProfiles,
  type AiRoleProfile,
  type AiRoleProfiles,
} from "../shared/ai-role-profiles";
import type { Role } from "../domain/access";

type AiAdminStatus = {
  roleProfiles: AiRoleProfiles;
  defaultRoleProfile: AiRoleProfile;
  enabled: boolean;
  webSearchEnabled: boolean;
  webSearchProvider: string;
  webSearchDefaultScope: string;
  active: boolean;
  configured: boolean;
  apiKeyConfigured: boolean;
  apiKeyStored: boolean;
  apiKeySource: "database" | "environment" | "none";
  credentialError: string;
  folderId: string;
  folderIdOverride: string;
  folderConfigured: boolean;
  folderSource: "database" | "environment" | "none";
  model: string;
  modelOverride: string;
  modelSource: "database" | "environment" | "default";
  compactionEnabled: boolean;
  compactThresholdTokens: number;
  automaticTruncation: boolean;
  maxToolIterations: number;
  models: Array<{
    id: string;
    label: string;
    owner: string;
  }>;
  modelsError: string;
  limits: {
    requestsPerMinute: number;
    dailyRequests: number;
    dailyTokens: number;
  };
  usage: {
    today: {
      requests: number;
      providerCalls: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      errors: number;
      averageLatencyMs: number;
      models: Array<{
        model: string;
        providerCalls: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }>;
    };
    history: Array<{
      day: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      models: Array<{
        model: string;
        providerCalls: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }>;
    }>;
    recent: Array<{
      id: number;
      at: string;
      userId: string;
      model: string;
      status: "ok" | "error";
      providerCalls: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      latencyMs: number;
    }>;
  };
  baseUrl: string;
};

export function AiSettingsAdmin() {
  const [status, setStatus] = useState<AiAdminStatus | null>(null),
    [enabled, setEnabled] = useState(true),
    [webSearchEnabled, setWebSearchEnabled] = useState(false),
    [apiKey, setApiKey] = useState(""),
    [clearApiKey, setClearApiKey] = useState(false),
    [folderId, setFolderId] = useState(""),
    [model, setModel] = useState(""),
    [requestsPerMinute, setRequestsPerMinute] = useState(6),
    [dailyRequests, setDailyRequests] = useState(100),
    [dailyTokens, setDailyTokens] = useState(250000),
    [compactionEnabled, setCompactionEnabled] = useState(true),
    [compactThresholdTokens, setCompactThresholdTokens] = useState(32000),
    [automaticTruncation, setAutomaticTruncation] = useState(true),
    [maxToolIterations, setMaxToolIterations] = useState(8),
    [roleProfiles, setRoleProfiles] = useState<AiRoleProfiles>(
      inheritedAiRoleProfiles,
    ),
    [busy, setBusy] = useState(false),
    [testing, setTesting] = useState(false),
    [loadingModels, setLoadingModels] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");

  const applyStatus = useCallback((next: AiAdminStatus) => {
    setStatus(next);
    setEnabled(next.enabled);
    setWebSearchEnabled(next.webSearchEnabled);
    setFolderId(next.folderIdOverride || next.folderId || "");
    const selectedModel = next.modelOverride || next.model || "";
    setModel(selectedModel || next.models[0]?.id || "");
    setApiKey("");
    setClearApiKey(false);
    setRequestsPerMinute(next.limits.requestsPerMinute);
    setDailyRequests(next.limits.dailyRequests);
    setDailyTokens(next.limits.dailyTokens);
    setCompactionEnabled(next.compactionEnabled);
    setCompactThresholdTokens(next.compactThresholdTokens);
    setAutomaticTruncation(next.automaticTruncation);
    setMaxToolIterations(next.maxToolIterations);
    setRoleProfiles(next.roleProfiles);
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
          body: JSON.stringify({
            enabled,
            webSearchEnabled,
            model,
            folderId,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            clearApiKey,
            requestsPerMinute,
            dailyRequests,
            dailyTokens,
            compactionEnabled,
            compactThresholdTokens,
            automaticTruncation,
            maxToolIterations,
            roleProfiles,
          }),
        }),
        data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "Не удалось сохранить настройки AI Studio",
        );
      applyStatus(data as AiAdminStatus);
      setNotice("Настройки AI Studio сохранены");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(role?: Role) {
    setTesting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
          `/api/admin/ai/test${role ? `?role=${role}` : ""}`,
          { method: "POST" },
        ),
        data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI Studio не ответила");
      setNotice(
        `Подключение работает · ${data.model}${data.answer ? ` · ${data.answer}` : ""}${compactionEnabled && !data.compactionAvailable ? " · Yandex не принимает сжатие контекста; используется автоматическое усечение" : ""}`,
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function refreshModels() {
    setLoadingModels(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/ai/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folderId,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }),
        }),
        data = (await response.json()) as {
          models?: AiAdminStatus["models"];
          error?: string;
        };
      if (!response.ok)
        throw new Error(data.error || "Не удалось получить список моделей");
      const models = data.models || [];
      setStatus((current) =>
        current ? { ...current, models, modelsError: "" } : current,
      );
      setModel((current) =>
        models.some((item) => item.id === current)
          ? current
          : models[0]?.id || "",
      );
      setNotice(
        models.length
          ? `Получено моделей: ${models.length}`
          : "В каталоге нет доступных текстовых моделей",
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoadingModels(false);
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
            <p>Общее подключение и отдельные AI-профили ролей.</p>
          </span>
        </div>
        {status && (
          <span
            className={`ai-runtime-state ${status.active ? "is-active" : "is-inactive"}`}
          >
            {status.active ? (
              <CheckCircle2 size={15} />
            ) : (
              <TriangleAlert size={15} />
            )}
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
          <details className="ai-admin-connection">
          <summary>Текущее подключение · {status.configured ? "настроено" : "требует настройки"}</summary>
          <div className="ai-config-status">
            <div>
              <b>API-ключ</b>
              <span>
                {status.apiKeyConfigured
                  ? status.apiKeySource === "database"
                    ? "Сохранён в Drevo"
                    : "Из окружения сервера"
                  : "Не задан"}
              </span>
            </div>
            <div>
              <b>Folder ID</b>
              <span>
                {status.folderConfigured
                  ? `${status.folderId} · ${
                      status.folderSource === "database" ? "Drevo" : "окружение"
                    }`
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
          </details>

          <form onSubmit={save}>
            <label
              className="setting-toggle"
              htmlFor="ai-web-search-enabled"
              aria-label="Поиск в интернете"
            >
              <span>
                <b>Поиск в интернете</b>
                <small>
                  Провайдер:{" "}
                  {status.webSearchProvider === "yandex"
                    ? "Yandex"
                    : status.webSearchProvider}
                  . По умолчанию: доверенные ресурсы каталога.
                </small>
              </span>
              <input
                id="ai-web-search-enabled"
                type="checkbox"
                checked={webSearchEnabled}
                disabled={busy}
                onChange={(event) => setWebSearchEnabled(event.target.checked)}
              />
            </label>
            <label
              className="setting-toggle"
              htmlFor="ai-research-enabled"
              aria-label="ИИ-исследователь"
            >
              <span>
                <b>ИИ-исследователь</b>
                <small>
                  Отключение скрывает панель ИИ и блокирует новые запросы, но не
                  удаляет настройки и предложения.
                </small>
              </span>
              <input
                id="ai-research-enabled"
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
            </label>

            <AiRoleProfilesEditor
              profiles={roleProfiles}
              defaults={{
                ...status.defaultRoleProfile,
                model,
                webSearchEnabled,
                requestsPerMinute,
                dailyRequests,
                dailyTokens,
                compactionEnabled,
                compactThresholdTokens,
                automaticTruncation,
                maxToolIterations,
              }}
              models={status.models}
              disabled={busy || testing}
              onChange={setRoleProfiles}
              onTest={(role) => void testConnection(role)}
            />

            <details className="ai-admin-connection">
              <summary>Подключение Yandex, общие лимиты и контекст</summary>
            <fieldset className="ai-credential-settings">
              <legend>Подключение и модель по умолчанию</legend>

              <label htmlFor="ai-api-key">
                API-ключ
                <input
                  id="ai-api-key"
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  placeholder={
                    status.apiKeyConfigured
                      ? "Оставьте пустым, чтобы не менять"
                      : "AQVN…"
                  }
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    if (event.target.value) setClearApiKey(false);
                  }}
                />
                <small>
                  Ключ отправляется только на сервер и хранится там
                  зашифрованным. Обратно в браузер он не возвращается.
                </small>
              </label>

              {status.apiKeyStored && (
                <label
                  className="setting-toggle"
                  htmlFor="ai-clear-api-key"
                  aria-label="Удалить сохранённый API-ключ"
                >
                  <span>
                    <b>Удалить сохранённый ключ</b>
                    <small>
                      После сохранения Drevo снова использует ключ из окружения,
                      если он там задан.
                    </small>
                  </span>
                  <input
                    id="ai-clear-api-key"
                    type="checkbox"
                    checked={clearApiKey}
                    onChange={(event) => {
                      setClearApiKey(event.target.checked);
                      if (event.target.checked) setApiKey("");
                    }}
                  />
                </label>
              )}

              <label htmlFor="ai-folder-id">
                Folder ID
                <input
                  id="ai-folder-id"
                  value={folderId}
                  maxLength={128}
                  placeholder="b1g…"
                  onChange={(event) => setFolderId(event.target.value)}
                />
              </label>

              <div className="ai-model-picker">
                <label htmlFor="ai-model">
                  Модель
                  <select
                    id="ai-model"
                    value={model}
                    disabled={!status.models.length && !model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {!status.models.some((item) => item.id === model) &&
                      model && (
                        <option value={model}>
                          {model} · текущее значение
                        </option>
                      )}
                    {!model && !status.models.length && (
                      <option value="">Загрузите модели каталога</option>
                    )}
                    {status.models.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="ai-model-refresh"
                  disabled={loadingModels || !folderId.trim()}
                  onClick={() => void refreshModels()}
                >
                  <RefreshCw
                    size={15}
                    className={loadingModels ? "spinning" : ""}
                  />
                  {loadingModels ? "Загружаем…" : "Обновить список"}
                </button>
                {status.modelsError && (
                  <small className="form-error">{status.modelsError}</small>
                )}
              </div>
            </fieldset>

            <details className="ai-context-settings">
              <summary>Контекст диалога</summary>
              <label
                className="setting-toggle"
                htmlFor="ai-compaction-enabled"
                aria-label="Сжимать длинный диалог"
              >
                <span>
                  <b>Сжимать длинный диалог</b>
                </span>
                <input
                  id="ai-compaction-enabled"
                  type="checkbox"
                  checked={compactionEnabled}
                  onChange={(event) =>
                    setCompactionEnabled(event.target.checked)
                  }
                />
              </label>
              <label htmlFor="ai-compact-threshold">
                Порог сжатия, токенов
                <input
                  id="ai-compact-threshold"
                  type="number"
                  min={1000}
                  max={1000000}
                  disabled={!compactionEnabled}
                  value={compactThresholdTokens}
                  onChange={(event) =>
                    setCompactThresholdTokens(Number(event.target.value))
                  }
                />
              </label>
              <label
                className="setting-toggle"
                htmlFor="ai-truncation-enabled"
                aria-label="Автоматически сокращать контекст при переполнении"
              >
                <span>
                  <b>Автоматически сокращать контекст при переполнении</b>
                </span>
                <input
                  id="ai-truncation-enabled"
                  type="checkbox"
                  checked={automaticTruncation}
                  onChange={(event) =>
                    setAutomaticTruncation(event.target.checked)
                  }
                />
              </label>
              <label htmlFor="ai-tool-iterations">
                Максимум шагов инструментов
                <input
                  id="ai-tool-iterations"
                  type="number"
                  min={1}
                  max={20}
                  value={maxToolIterations}
                  onChange={(event) =>
                    setMaxToolIterations(Number(event.target.value))
                  }
                />
              </label>
            </details>

            {status.credentialError && (
              <p className="form-error" role="alert">
                {status.credentialError}
              </p>
            )}

            <fieldset className="ai-limit-settings">
              <legend>Лимиты</legend>
              <label htmlFor="ai-rpm">
                Запросов в минуту на пользователя
                <input
                  id="ai-rpm"
                  type="number"
                  min={0}
                  max={120}
                  value={requestsPerMinute}
                  onChange={(event) =>
                    setRequestsPerMinute(Number(event.target.value))
                  }
                />
              </label>
              <label htmlFor="ai-daily-requests">
                Запросов в день на весь архив
                <input
                  id="ai-daily-requests"
                  type="number"
                  min={0}
                  max={100000}
                  value={dailyRequests}
                  onChange={(event) =>
                    setDailyRequests(Number(event.target.value))
                  }
                />
              </label>
              <label htmlFor="ai-daily-tokens">
                Токенов в день на весь архив
                <input
                  id="ai-daily-tokens"
                  type="number"
                  min={0}
                  max={1000000000}
                  value={dailyTokens}
                  onChange={(event) =>
                    setDailyTokens(Number(event.target.value))
                  }
                />
              </label>
              <small>Ноль отключает соответствующий лимит.</small>
            </fieldset>
            </details>

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

          <details className="ai-admin-connection ai-usage-details">
            <summary>Статистика · сегодня {status.usage.today.requests} запросов</summary>
          <section className="ai-usage-summary" aria-label="Использование ИИ">
            <h3>Использование сегодня</h3>
            <div className="ai-usage-stats">
              <div>
                <b>{status.usage.today.requests}</b>
                <span>
                  запросов
                  {status.limits.dailyRequests
                    ? ` / ${status.limits.dailyRequests}`
                    : ""}
                </span>
              </div>
              <div>
                <b>{status.usage.today.totalTokens.toLocaleString("ru-RU")}</b>
                <span>
                  вход {status.usage.today.inputTokens.toLocaleString("ru-RU")}{" "}
                  · выход{" "}
                  {status.usage.today.outputTokens.toLocaleString("ru-RU")}
                  {status.limits.dailyTokens
                    ? ` · лимит ${status.limits.dailyTokens.toLocaleString("ru-RU")}`
                    : ""}
                </span>
              </div>
              <div>
                <b>{status.usage.today.providerCalls}</b>
                <span>вызовов AI Studio</span>
              </div>
              <div>
                <b>{status.usage.today.averageLatencyMs} мс</b>
                <span>средняя задержка</span>
              </div>
              <div>
                <b>{status.usage.today.errors}</b>
                <span>ошибок</span>
              </div>
            </div>
            <div className="ai-token-chart">
              <h4>Расход токенов за 14 дней</h4>
              <AiTokenUsageChart history={status.usage.history} />
            </div>
            {status.usage.recent.length > 0 && (
              <div className="ai-usage-recent">
                <h4>Последние запросы</h4>
                {status.usage.recent.slice(0, 10).map((item) => (
                  <article key={item.id}>
                    <span className={item.status === "ok" ? "ok" : "error"}>
                      {item.status === "ok" ? "OK" : "Ошибка"}
                    </span>
                    <div>
                      <b>{item.model}</b>
                      <small>
                        {new Date(item.at).toLocaleString("ru-RU")} · вход{" "}
                        {item.inputTokens.toLocaleString("ru-RU")} · выход{" "}
                        {item.outputTokens.toLocaleString("ru-RU")} ·{" "}
                        {item.providerCalls} выз. · {item.latencyMs} мс
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <p className="ai-usage-privacy">
              Сохраняются только технические счётчики. Тексты запросов, ответов
              и аргументы Research Tools в журнал использования не записываются.
            </p>
          </section>
          </details>
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
