import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Bot, CheckCircle2, Save, TriangleAlert } from "lucide-react";
import { AiTokenUsageChart } from "./charts/ai-token-usage-chart";
import { AiRoleProfilesEditor } from "./ai-role-profiles-editor";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";
import { AiProviderCleanupAdmin } from "./ai-provider-cleanup-admin";
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
  codeInterpreterEnabled: boolean;
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

export function AiSettingsAdmin({
  showCleanup = true,
  onDirtyChange,
}: {
  showCleanup?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [status, setStatus] = useState<AiAdminStatus | null>(null),
    [enabled, setEnabled] = useState(true),
    [webSearchEnabled, setWebSearchEnabled] = useState(false),
    [codeInterpreterEnabled, setCodeInterpreterEnabled] = useState(false),
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

  const draft = useMemo(
    () => ({
      enabled,
      webSearchEnabled,
      codeInterpreterEnabled,
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
    [
      enabled,
      webSearchEnabled,
      codeInterpreterEnabled,
      model,
      folderId,
      apiKey,
      clearApiKey,
      requestsPerMinute,
      dailyRequests,
      dailyTokens,
      compactionEnabled,
      compactThresholdTokens,
      automaticTruncation,
      maxToolIterations,
      roleProfiles,
    ],
  );
  const [savedDraft, setSavedDraft] = useState("");
  const modelsRequest = useRef<AbortController | null>(null);
  const draftKey = JSON.stringify(draft);
  const dirty = Boolean(status) && draftKey !== savedDraft;
  useUnsavedChanges(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const applyStatus = useCallback((next: AiAdminStatus) => {
    setStatus(next);
    setEnabled(next.enabled);
    setWebSearchEnabled(next.webSearchEnabled);
    setCodeInterpreterEnabled(next.codeInterpreterEnabled);
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
    const profiles = Object.fromEntries(
      (["admin", "researcher", "relative", "reader"] as const).map((role) => [
        role,
        {
          // TODO(remove): R7.2 in docs/roadmap.md, after explicit role migration.
          ...(next.roleProfiles[role] || next.defaultRoleProfile),
          model:
            next.roleProfiles[role]?.model ||
            selectedModel ||
            next.models[0]?.id ||
            "",
          ...(role === "reader" ? { proposalsEnabled: false } : {}),
        },
      ]),
    ) as AiRoleProfiles;
    setRoleProfiles(profiles);
    setSavedDraft(
      JSON.stringify({
        enabled: next.enabled,
        webSearchEnabled: next.webSearchEnabled,
        codeInterpreterEnabled: next.codeInterpreterEnabled,
        model: selectedModel || next.models[0]?.id || "",
        folderId: next.folderIdOverride || next.folderId || "",

        clearApiKey: false,
        requestsPerMinute: next.limits.requestsPerMinute,
        dailyRequests: next.limits.dailyRequests,
        dailyTokens: next.limits.dailyTokens,
        compactionEnabled: next.compactionEnabled,
        compactThresholdTokens: next.compactThresholdTokens,
        automaticTruncation: next.automaticTruncation,
        maxToolIterations: next.maxToolIterations,
        roleProfiles: profiles,
      }),
    );
  }, []);

  const loadModels = useCallback(
    async (configuration: {
      folderId: string;
      apiKey?: string;
      forceRefresh?: boolean;
    }) => {
      modelsRequest.current?.abort();
      const controller = new AbortController();
      modelsRequest.current = controller;
      setLoadingModels(true);
      try {
        const response = await fetch("/api/admin/ai/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(configuration),
          signal: controller.signal,
        });
        const data = (await response.json()) as {
          models?: AiAdminStatus["models"];
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || "Не удалось получить список моделей");
        if (controller.signal.aborted) return;
        const models = data.models || [];
        setStatus((current) =>
          current
            ? {
                ...current,
                models,
                modelsError: models.length
                  ? ""
                  : "В каталоге нет доступных текстовых моделей. Проверьте Folder ID и права API-ключа.",
              }
            : current,
        );
      } catch (reason) {
        if (!controller.signal.aborted)
          setStatus((current) =>
            current
              ? {
                  ...current,
                  modelsError:
                    reason instanceof Error
                      ? reason.message
                      : "Не удалось получить список моделей",
                }
              : current,
          );
      } finally {
        if (!controller.signal.aborted) setLoadingModels(false);
      }
    },
    [],
  );

  const load = useCallback(async (signal: AbortSignal) => {
    const response = await fetch("/api/admin/ai?models=0", {
        cache: "no-store",
        signal,
      }),
      data = await response.json();
    if (signal.aborted) return;
    if (!response.ok)
      throw new Error(data.error || "Не удалось загрузить настройки AI Studio");
    applyStatus(data as AiAdminStatus);
    if (data.apiKeyConfigured && data.folderId)
      void loadModels({ folderId: data.folderId });
  }, [applyStatus, loadModels]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void load(controller.signal).catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      });
    });
    return () => {
      controller.abort();
      modelsRequest.current?.abort();
    };
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/ai?models=0", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        }),
        data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "Не удалось сохранить настройки AI Studio",
        );
      applyStatus({
        ...data,
        models: status?.models || [],
        modelsError: status?.modelsError || "",
      } as AiAdminStatus);
      if (data.apiKeyConfigured && data.folderId &&
          (apiKey.trim() || clearApiKey || data.folderId !== status?.folderId))
        void loadModels({ folderId: data.folderId });
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
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(draft),
          },
        ),
        data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI Studio не ответила");
      setNotice(
        `Проверка текущих настроек успешна · ${status?.models.find((item) => item.id === data.model)?.label || data.model}${data.answer ? ` · ${data.answer}` : ""}${(role ? roleProfiles[role]?.compactionEnabled : compactionEnabled) && !data.compactionAvailable ? " · Yandex не принимает сжатие контекста; используется автоматическое усечение" : ""}`,
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function refreshModels() {
    setError("");
    setNotice("");
    await loadModels({
      folderId,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      forceRefresh: true,
    });
  }

  if (!status && !error)
    return (
      <section className="admin-card archive-form ai-settings-admin">
        <p role="status">Проверяем конфигурацию…</p>
      </section>
    );

  return (
    <section className="admin-card archive-form ai-settings-admin">
      <div className="ai-settings-title">
        <span className="ai-provider-name">
          <Bot size={16} /> Yandex AI Studio
        </span>
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
          <form
            onSubmit={save}
            onChangeCapture={() => {
              setNotice("");
              setError("");
            }}
            onInvalidCapture={(event) => {
              let parent = (event.target as HTMLElement).parentElement;
              while (parent && parent !== event.currentTarget) {
                if (parent instanceof HTMLDetailsElement) parent.open = true;
                parent = parent.parentElement;
              }
            }}
          >
            <fieldset className="ai-settings-fields" disabled={busy || testing}>
              <label
                className="setting-toggle"
                htmlFor="ai-research-enabled"
                aria-label="ИИ-исследователь"
              >
                <span>
                  <b>ИИ-исследователь</b>
                  <small>
                    Единое подключение для всех древ. Доступ и лимиты задаются
                    по ролям.
                  </small>
                </span>
                <input
                  id="ai-research-enabled"
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
              </label>
              <section
                className="ai-settings-section"
                aria-label="Подключение Yandex"
              >
                <details
                  className="ai-admin-connection ai-connection-editor"
                  open={!status.configured || undefined}
                >
                  <summary>
                    Подключение Яндекс ·{" "}
                    {status.configured ? "настроено" : "не настроено"}
                  </summary>
                  <fieldset className="ai-credential-settings">
                    <legend>Общее подключение</legend>

                    <label htmlFor="ai-api-key">
                      API-ключ
                      <input
                        id="ai-api-key"
                        aria-label="API-ключ"
                        aria-describedby="ai-api-key-hint"
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
                      <small id="ai-api-key-hint">
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
                            После сохранения Drevo снова использует ключ из
                            окружения, если он там задан.
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
                  </fieldset>{" "}
                  {status.credentialError && (
                    <p className="form-error" role="alert">
                      {status.credentialError}
                    </p>
                  )}
                </details>
              </section>
              <section
                className="ai-settings-section"
                aria-label="Доступ по ролям"
              >
                <AiRoleProfilesEditor
                  profiles={roleProfiles}
                  defaults={{
                    ...status.defaultRoleProfile,
                    model,
                  }}
                  models={status.models}
                  disabled={busy || testing}
                  globallyEnabled={enabled}
                  loadingModels={loadingModels}
                  modelsError={status.modelsError}
                  canLoadModels={
                    !!folderId.trim() &&
                    (!!apiKey.trim() || status.apiKeyConfigured)
                  }
                  onRefreshModels={() => void refreshModels()}
                  onChange={setRoleProfiles}
                  onTest={(role) => void testConnection(role)}
                />
              </section>
              <section
                className="ai-settings-section"
                aria-label="Расход и бюджет"
              >
                <details className="ai-admin-connection ai-usage-details">
                  <summary>
                    Расход · сегодня {status.usage.today.requests} запросов
                  </summary>
                  <section
                    className="ai-usage-summary"
                    aria-label="Использование ИИ"
                  >
                    <h3>Использование сегодня</h3>
                    <p>Все пользователи и древа платформы.</p>
                    <div className="ai-usage-stats">
                      <div>
                        <b>{status.usage.today.requests}</b>
                        <span>запросов</span>
                      </div>
                      <div>
                        <b>
                          {status.usage.today.totalTokens.toLocaleString(
                            "ru-RU",
                          )}
                        </b>
                        <span>
                          вход{" "}
                          {status.usage.today.inputTokens.toLocaleString(
                            "ru-RU",
                          )}{" "}
                          · выход{" "}
                          {status.usage.today.outputTokens.toLocaleString(
                            "ru-RU",
                          )}
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
                            <span
                              className={item.status === "ok" ? "ok" : "error"}
                            >
                              {item.status === "ok" ? "OK" : "Ошибка"}
                            </span>
                            <div>
                              <b>{item.model}</b>
                              <small>
                                {new Date(item.at).toLocaleString("ru-RU")} ·
                                вход {item.inputTokens.toLocaleString("ru-RU")}{" "}
                                · выход{" "}
                                {item.outputTokens.toLocaleString("ru-RU")} ·{" "}
                                {item.providerCalls} выз. · {item.latencyMs} мс
                              </small>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                    <p className="ai-usage-privacy">
                      Сохраняются только технические счётчики. Тексты запросов,
                      ответов и аргументы Research Tools в журнал использования
                      не записываются.
                    </p>
                  </section>
                </details>
              </section>
            </fieldset>
            <footer className="ai-settings-actions">
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
              <button
                type="submit"
                className="primary-action"
                disabled={busy || testing || !dirty}
              >
                <Save size={16} />
                {busy ? "Сохраняем…" : "Сохранить"}
              </button>
              <span className="ai-draft-state" role="status">
                {dirty ? "Есть изменения" : "Все изменения сохранены"}
              </span>
            </footer>
          </form>

          <details className="ai-admin-connection">
            <summary>
              Текущее подключение ·{" "}
              {status.configured ? "настроено" : "требует настройки"}
            </summary>
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
                        status.folderSource === "database"
                          ? "Drevo"
                          : "окружение"
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

          {showCleanup && <AiProviderCleanupAdmin platform />}
        </>
      )}

      {!status && error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
