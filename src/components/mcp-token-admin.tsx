import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveResourceUrl, scopedArchivePath } from "../domain/archive-context.ts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";

type McpScope = "tree:read" | "sources:read" | "analysis:read";
type McpTokenItem = {
  id: string;
  name: string;
  tokenHint: string;
  scopes: McpScope[];
  createdAt: string;
  createdBy: string;
  expiresAt?: number;
  revokedAt?: string;
  lastUsedAt?: number;
  rateLimitPerMinute: number;
  usage: {
    callsToday: number;
    errorsToday: number;
    averageLatencyMs: number;
  };
  boundUser?: {
    id: string;
    name: string;
    role: string;
    personId?: string;
    treeAccess?: "all" | "common_ancestors";
  };
};
type McpUsageItem = {
  id: number;
  at: string;
  tokenId: string;
  method: string;
  toolName?: string;
  status: "ok" | "error";
  latencyMs: number;
};

const scopeLabels: Record<McpScope, string> = {
  "tree:read": "Чтение древа",
  "sources:read": "Источники",
  "analysis:read": "Анализ",
};
const scopePresets = [
  {
    value: "all",
    label: "Все инструменты",
    scopes: ["tree:read", "sources:read", "analysis:read"],
  },
  {
    value: "tree-sources",
    label: "Древо и источники",
    scopes: ["tree:read", "sources:read"],
  },
  {
    value: "tree-analysis",
    label: "Древо и анализ",
    scopes: ["tree:read", "analysis:read"],
  },
  {
    value: "sources-analysis",
    label: "Источники и анализ",
    scopes: ["sources:read", "analysis:read"],
  },
  { value: "tree", label: "Только древо", scopes: ["tree:read"] },
  { value: "sources", label: "Только источники", scopes: ["sources:read"] },
  { value: "analysis", label: "Только анализ", scopes: ["analysis:read"] },
] as const satisfies ReadonlyArray<{
  value: string;
  label: string;
  scopes: readonly McpScope[];
}>;
type McpScopePreset = (typeof scopePresets)[number]["value"];

export function McpTokenAdmin({ archiveId }: { archiveId: string | null }) {
  const pathname = archiveId ? `/a/${archiveId}` : "/";
  const endpoint = archiveResourceUrl("/api/mcp/tokens", pathname);
  const connectionPath = scopedArchivePath("/mcp", pathname);
  const [tokens, setTokens] = useState<McpTokenItem[]>([]),
    [recentUsage, setRecentUsage] = useState<McpUsageItem[]>([]),
    [name, setName] = useState("Yandex AI Studio"),
    [expiresDays, setExpiresDays] = useState("365"),
    [rateLimitPerMinute, setRateLimitPerMinute] = useState("60"),
    [scopePreset, setScopePreset] = useState<McpScopePreset>("all"),
    [secret, setSecret] = useState(""),
    [copied, setCopied] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await archiveFetch(endpoint, { cache: "no-store", signal }),
      data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Не удалось загрузить MCP-токены");
    if (signal?.aborted) return;
    setTokens(data.tokens || []);
    setRecentUsage(data.recentUsage || []);
  }, [endpoint]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!active) return;
      void load(controller.signal).catch((reason) => {
        if (active) setError((reason as Error).message);
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [load]);

  async function createToken(event: FormEvent) {
    event.preventDefault();
    const scopes = scopePresets.find(
      (preset) => preset.value === scopePreset,
    )!.scopes;
    setBusy(true);
    setError("");
    setSecret("");
    try {
      const response = await archiveFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            scopes,
            ...(expiresDays ? { expiresDays: Number(expiresDays) } : {}),
            rateLimitPerMinute: Number(rateLimitPerMinute),
          }),
        }),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось создать MCP-токен");
      setSecret(data.token);
      setCopied(false);
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Отозвать этот MCP-токен? Подключения с ним перестанут работать."))
      return;
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch(
          `${endpoint}/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        ),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось отозвать MCP-токен");
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-card archive-form mcp-token-admin">
      <p>
        Токены дают внешним ИИ-клиентам доступ к исследовательским инструментам
        Drevo через <code className="mcp-endpoint">{connectionPath}</code>. Каждый токен видит весь архив, а секрет
        показывается только один раз.
      </p>
      <form className="mcp-token-create" onSubmit={createToken}>
        <label>
          Название
          <input
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Разрешения
          <select
            value={scopePreset}
            onChange={(event) =>
              setScopePreset(event.target.value as McpScopePreset)
            }
          >
            {scopePresets.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <details className="mcp-token-options">
          <summary>Срок и лимит запросов</summary>
          <div>
            <label>
              Срок, дней
              <input
                type="number"
                min={1}
                max={3650}
                value={expiresDays}
                placeholder="Без срока"
                onChange={(event) => setExpiresDays(event.target.value)}
              />
            </label>
            <label>
              Запросов в минуту
              <input
                type="number"
                min={0}
                max={600}
                value={rateLimitPerMinute}
                onChange={(event) => setRateLimitPerMinute(event.target.value)}
              />
              <small>0 — без ограничения</small>
            </label>
          </div>
        </details>
        <button
          type="submit"
          className="primary-action"
          disabled={busy}
        >
          <Plus size={16} />
          {busy ? "Создаём…" : "Создать токен"}
        </button>
      </form>

      {secret && (
        <div className="mcp-secret" role="status">
          <b>Скопируйте токен сейчас</b>
          <p>После закрытия этой страницы полный секрет больше не показывается.</p>
          <div>
            <code>{secret}</code>
            <button
              type="button"
              aria-label="Скопировать MCP-токен"
              onClick={async () => {
                await navigator.clipboard.writeText(secret);
                setCopied(true);
              }}
            >
              {copied ? <Check size={17} /> : <Copy size={17} />}
            </button>
          </div>
        </div>
      )}

      <div className="mcp-token-list">
        {tokens.length ? (
          tokens.map((token) => (
            <article key={token.id} className={token.revokedAt ? "revoked" : ""}>
              <KeyRound size={18} />
              <div>
                <b>{token.name}</b>
                <code>{token.tokenHint}</code>
                <small>
                  {token.scopes.map((scope) => scopeLabels[scope]).join(" · ")}
                </small>
                <small>
                  Создан {new Date(token.createdAt).toLocaleString("ru-RU")}
                  {token.expiresAt
                    ? ` · действует до ${new Date(token.expiresAt).toLocaleDateString("ru-RU")}`
                    : " · без срока"}
                  {token.lastUsedAt
                    ? ` · использован ${new Date(token.lastUsedAt).toLocaleString("ru-RU")}`
                    : ""}
                </small>
                <small>
                  Доступ:{" "}
                  {token.boundUser
                    ? `${token.boundUser.name} · ${
                        token.boundUser.treeAccess === "common_ancestors"
                          ? "кровные и их супруги"
                          : "весь архив"
                      }`
                    : "весь архив"}
                </small>
                <small>
                  Лимит: {token.rateLimitPerMinute || "∞"}/мин · сегодня:{" "}
                  {token.usage.callsToday} выз. · ошибок {token.usage.errorsToday}
                  {" · "}ср. {token.usage.averageLatencyMs} мс
                </small>
                {token.revokedAt && <small>Отозван</small>}
              </div>
              {!token.revokedAt && (
                <button
                  type="button"
                  aria-label={`Отозвать токен: ${token.name}`}
                  disabled={busy}
                  onClick={() => void revoke(token.id)}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </article>
          ))
        ) : (
          <p>Выданных MCP-токенов пока нет.</p>
        )}
      </div>

      {recentUsage.length > 0 && (
        <div className="mcp-usage-list">
          <h3>Последние MCP-вызовы</h3>
          {recentUsage.slice(0, 20).map((item) => {
            const token = tokens.find((entry) => entry.id === item.tokenId);
            return (
              <article key={item.id}>
                <span className={item.status === "ok" ? "ok" : "error"}>
                  {item.status === "ok" ? "OK" : "Ошибка"}
                </span>
                <div>
                  <b>
                    {item.toolName
                      ? `${item.method} · ${item.toolName}`
                      : item.method}
                  </b>
                  <small>
                    {token?.name || "Удалённый токен"} ·{" "}
                    {new Date(item.at).toLocaleString("ru-RU")} ·{" "}
                    {item.latencyMs} мс
                  </small>
                </div>
              </article>
            );
          })}
          <p>
            Аргументы вызовов в журнал не записываются.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
