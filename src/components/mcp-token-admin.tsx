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
};

const scopeLabels: Record<McpScope, string> = {
  "tree:read": "Чтение древа",
  "sources:read": "Источники",
  "analysis:read": "Анализ",
};

export function McpTokenAdmin() {
  const [tokens, setTokens] = useState<McpTokenItem[]>([]),
    [name, setName] = useState("Yandex AI Studio"),
    [expiresDays, setExpiresDays] = useState("365"),
    [scopes, setScopes] = useState<McpScope[]>([
      "tree:read",
      "sources:read",
      "analysis:read",
    ]),
    [secret, setSecret] = useState(""),
    [copied, setCopied] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/mcp/tokens", { cache: "no-store" }),
      data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Не удалось загрузить MCP-токены");
    setTokens(data.tokens || []);
  }, []);

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

  async function createToken(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSecret("");
    try {
      const response = await fetch("/api/mcp/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            scopes,
            ...(expiresDays ? { expiresDays: Number(expiresDays) } : {}),
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
      const response = await fetch(
          `/api/mcp/tokens/${encodeURIComponent(id)}`,
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
      <h2>MCP-токены</h2>
      <p>
        Токены дают внешним ИИ-клиентам доступ к исследовательским инструментам
        Drevo через <code>/mcp</code>. Секрет показывается только один раз.
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
        <fieldset>
          <legend>Разрешения</legend>
          {(Object.keys(scopeLabels) as McpScope[]).map((scope) => (
            <label key={scope} className="mcp-scope">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked
                      ? [...current, scope]
                      : current.filter((item) => item !== scope),
                  )
                }
              />
              {scopeLabels[scope]}
            </label>
          ))}
        </fieldset>
        <button
          type="submit"
          className="primary-action"
          disabled={busy || !scopes.length}
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
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
