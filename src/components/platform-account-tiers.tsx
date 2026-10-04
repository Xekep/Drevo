import { useEffect, useRef, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

type AccountTier = { id: string; name: string; fullAccess: boolean };
type TierPage = { accounts: AccountTier[]; next: string | null;
  totals: { basic: number; full: number } };
type OwnedUsage = { owned: boolean; people: number | null; mediaBytes: number | null };

/** Account access level is independent of the global role and tree grants. */
export function PlatformAccountTiers({ currentAccountId, onOwnTierChanged }: {
  currentAccountId: string;
  onOwnTierChanged: (fullAccess: boolean) => void;
}) {
  const [accounts, setAccounts] = useState<AccountTier[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [totals, setTotals] = useState<TierPage["totals"] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<Record<string, OwnedUsage>>({});
  const [usageBusy, setUsageBusy] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<Record<string, string>>({});
  const listVersion = useRef(0);
  const load = async (after = "") => {
    if (loading || (after && after !== next)) return;
    setLoading(true);
    setError("");
    const version = listVersion.current;
    try {
      const response = await archiveFetch(`/api/platform/tiers${after
        ? `?after=${encodeURIComponent(after)}` : ""}`, { cache: "no-store" });
      const page = await response.json() as TierPage & { error?: string };
      if (!response.ok) throw new Error(page.error || "Не удалось загрузить уровни доступа");
      if (version !== listVersion.current) return;
      setAccounts((current) => {
        if (!after) return page.accounts;
        const known = new Set(current.map((account) => account.id));
        return [...current, ...page.accounts.filter((account) => !known.has(account.id))];
      });
      setNext(page.next);
      setTotals(page.totals);
    } catch (cause) {
      if (version === listVersion.current)
        setError(cause instanceof Error ? cause.message : "Не удалось загрузить уровни доступа");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let active = true;
    void archiveFetch("/api/platform/tiers", { cache: "no-store" })
      .then(async (response) => {
        const page = await response.json() as TierPage & { error?: string };
        if (!response.ok) throw new Error(page.error || "Не удалось загрузить уровни доступа");
        if (active) {
          setAccounts(page.accounts);
          setNext(page.next);
          setTotals(page.totals);
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Не удалось загрузить уровни доступа");
      });
    return () => { active = false; };
  }, []);

  const change = async (account: AccountTier, fullAccess: boolean) => {
    listVersion.current++;
    setBusy(account.id);
    setError("");
    // The select follows the requested value immediately. An error restores
    // the last confirmed value, and a stale view is refreshed from the server.
    setAccounts((current) => current.map((item) => item.id === account.id
      ? { ...item, fullAccess } : item));
    try {
      const response = await archiveFetch(
        `/api/platform/tiers/${encodeURIComponent(account.id)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedFullAccess: account.fullAccess, fullAccess }),
        });
      const result = await response.json() as { error?: string };
      if (response.status === 409) {
        const fresh = await archiveFetch(
          `/api/platform/tiers/${encodeURIComponent(account.id)}`, { cache: "no-store" });
        if (!fresh.ok) throw new Error(result.error || "Обновите список и повторите действие");
        const current = await fresh.json() as { fullAccess: boolean };
        setAccounts((rows) => rows.map((row) => row.id === account.id
          ? { ...row, fullAccess: current.fullAccess } : row));
        // Another administrator may have changed other tiers too; the old
        // aggregate is no longer authoritative until the list is refreshed.
        setTotals(null);
        setError(result.error || "Уровень изменился. Проверьте новое значение и повторите действие");
        return;
      }
      if (!response.ok) throw new Error(result.error || "Не удалось изменить уровень доступа");
      if (account.id === currentAccountId) onOwnTierChanged(fullAccess);
      if (account.fullAccess !== fullAccess)
        setTotals((value) => value ? { basic: value.basic + (fullAccess ? -1 : 1),
          full: value.full + (fullAccess ? 1 : -1) } : value);
    } catch (cause) {
      setAccounts((current) => current.map((item) => item.id === account.id
        ? account : item));
      setError(cause instanceof Error ? cause.message : "Не удалось изменить уровень доступа");
    } finally {
      setBusy(null);
    }
  };
  const inspectUsage = async (accountId: string) => {
    setUsageBusy(accountId);
    setUsageError((current) => ({ ...current, [accountId]: "" }));
    try {
      const response = await archiveFetch(
        `/api/platform/tiers/${encodeURIComponent(accountId)}/usage`, { cache: "no-store" });
      const body = await response.json() as OwnedUsage & { error?: string };
      if (!response.ok) throw new Error(body.error || "Не удалось проверить расход");
      setUsage((current) => ({ ...current, [accountId]: body }));
    } catch (cause) {
      setUsageError((current) => ({ ...current, [accountId]:
        cause instanceof Error ? cause.message : "Не удалось проверить расход" }));
    } finally {
      setUsageBusy(null);
    }
  };

  return <section className="account-card" aria-labelledby="platform-tiers-title">
    <div className="account-card-title"><div>
      <span className="account-eyebrow">Платформа</span>
      <h2 id="platform-tiers-title">Уровень доступа</h2>
    </div></div>
    <p className="account-card-copy">Полный уровень включает расширенные возможности,
      но не открывает чужие деревья и не назначает глобальную роль.</p>
    {totals && <p className="account-card-copy" aria-label="Сводка уровней доступа">
      Базовый: {totals.basic} · Полный: {totals.full}
    </p>}
    {accounts.map((account) => <div className="account-tier-entry" key={account.id}>
      <div className="account-archive-row platform-role-row">
        <span className="account-archive-name"><strong>{account.name}</strong><small>{account.id}</small></span>
        <label><span className="sr-only">Уровень доступа {account.name}</span>
          <select value={account.fullAccess ? "full" : "basic"} disabled={busy !== null || loading}
            onChange={(event) => void change(account, event.target.value === "full") }>
            <option value="basic">Базовый</option>
            <option value="full">Полный</option>
          </select></label>
        <button type="button" className="account-row-action"
          disabled={usageBusy !== null} onClick={() => void inspectUsage(account.id)}>
          {usageBusy === account.id ? "Проверяем…" : "Расход"}
        </button>
      </div>
      {usage[account.id] && <p className="account-card-copy" role="status">
        {usage[account.id].owned ? <>
          Людей: {usage[account.id].people}; файлы: {usage[account.id].mediaBytes === null
            ? "объём не подтверждён" : `${new Intl.NumberFormat("ru-RU", {
              maximumFractionDigits: 1 }).format(usage[account.id].mediaBytes! / 1_000_000)} МБ`}
        </> : "Своё дерево ещё не создано; расход неизвестен"}
      </p>}
      {usageError[account.id] && <p role="alert" className="form-error">{usageError[account.id]}</p>}
    </div>)}
    {next && <button type="button" className="account-row-action" disabled={busy !== null || loading}
      onClick={() => void load(next)}>Показать ещё</button>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {error && <button type="button" className="account-row-action" disabled={loading || busy !== null}
      onClick={() => void load()}>Обновить список</button>}
  </section>;
}
