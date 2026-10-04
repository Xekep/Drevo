import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";

type Role = "admin" | "researcher" | null;
type Account = { id: string; name: string; role: Role };

/** Account-scoped administration; no selected archive or family is required. */
export function PlatformStaffRoles({ currentAccountId, onOwnRoleChanged }: {
  currentAccountId: string;
  onOwnRoleChanged: (role: Role) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async (after = "") => {
    if (loading || !after || after !== next) return;
    setLoading(true);
    try {
      const response = await archiveFetch(`/api/platform/roles?after=${encodeURIComponent(after)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось загрузить роли");
      setAccounts((current) => {
        const seen = new Set(current.map((account) => account.id));
        return [...current, ...body.accounts.filter((account: Account) => !seen.has(account.id))];
      });
      setNext(body.next);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let active = true;
    void archiveFetch("/api/platform/roles")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Не удалось загрузить роли");
        if (active) {
          setAccounts(body.accounts);
          setNext(body.next);
        }
      })
      .catch((cause) => active && setError(String(cause.message || cause)));
    return () => { active = false; };
  }, []);
  const change = async (account: Account, role: Role) => {
    setBusy(account.id);
    setError("");
    try {
      const response = await archiveFetch(
        `/api/platform/roles/${encodeURIComponent(account.id)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось изменить роль");
      setAccounts((current) => current.map((item) =>
        item.id === account.id ? { ...item, role: body.role } : item));
      if (account.id === currentAccountId) onOwnRoleChanged(body.role);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить роль");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="account-card" aria-labelledby="platform-roles-title">
      <div className="account-card-title"><div>
        <span className="account-eyebrow">Платформа</span>
        <h2 id="platform-roles-title">Глобальные роли</h2>
      </div></div>
      <p className="account-card-copy">
        Администратор и исследователь назначаются для платформы. Роль не даёт доступ к чужому дереву: для него требуется отдельное приглашение.
      </p>
      {accounts.map((account) => (
        <div className="account-archive-row platform-role-row" key={account.id}>
          <span className="account-archive-name"><strong>{account.name}</strong><small>{account.id}</small></span>
          <label>
            <span className="sr-only">Роль {account.name}</span>
            <select value={account.role || ""} disabled={busy !== null}
              onChange={(event) => void change(account, (event.target.value || null) as Role)}>
              <option value="">Нет глобальной роли</option>
              <option value="researcher">Исследователь</option>
              <option value="admin">Администратор</option>
            </select>
          </label>
        </div>
      ))}
      {next && <button className="account-row-action" disabled={busy !== null || loading}
        onClick={() => void load(next).catch((cause) => setError(String(cause.message || cause)))}>
        Показать ещё
      </button>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </section>
  );
}
