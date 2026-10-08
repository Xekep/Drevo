import { useEffect, useRef, useState } from "react";
import { BarChart3, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import type { PlatformAccount, PlatformAccountPage } from "../shared/platform-accounts";
import { PlatformAccountStatisticsDialog } from "./platform-account-statistics";
import "../styles/platform-accounts-admin.css";

export function PlatformAccountsAdmin({ currentAccountId, onOwnRoleChanged, onOwnTierChanged }: {
  currentAccountId: string;
  onOwnRoleChanged: (role: PlatformAccount["role"]) => void;
  onOwnTierChanged: (fullAccess: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState([""]);
  const [page, setPage] = useState<PlatformAccountPage>({ accounts: [], next: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [statistics, setStatistics] = useState<{ account: PlatformAccount | null } | null>(null);
  const read = useRef<AbortController | null>(null);
  const version = useRef(0);
  const after = cursors.at(-1)!;
  useEffect(() => {
    const timer = setTimeout(() => {
      const value = text.trim();
      if (value !== query) { setLoading(true); setError(""); setCursors([""]); setQuery(value); }
    }, 250);
    return () => clearTimeout(timer);
  }, [text, query]);
  useEffect(() => {
    const controller = new AbortController();
    read.current = controller;
    const requestVersion = ++version.current;
    const parameters = new URLSearchParams();
    if (query) parameters.set("q", query);
    if (after) parameters.set("after", after);
    void fetch(`/api/platform/accounts${parameters.size ? `?${parameters}` : ""}`,
      { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось загрузить пользователей.");
      if (!controller.signal.aborted && requestVersion === version.current) setPage(body);
    }).catch((reason) => {
      if (!controller.signal.aborted && requestVersion === version.current) {
        setPage({ accounts: [], next: null }); setError(reason.message);
      }
    }).finally(() => { if (!controller.signal.aborted && requestVersion === version.current) setLoading(false); });
    return () => controller.abort();
  }, [query, after, refresh]);

  async function change(account: PlatformAccount, update: { role: PlatformAccount["role"] } | { fullAccess: boolean }) {
    if (busy || loading) return;
    setBusy(account.id); setError("");
    read.current?.abort(); version.current++;
    const role = "role" in update;
    const endpoint = `/api/platform/${role ? "roles" : "tiers"}/${encodeURIComponent(account.id)}`;
    try {
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(role ? update : { ...update, expectedFullAccess: account.fullAccess }) });
      const body = await response.json();
      if (response.status === 409 && !role) {
        const latest = await fetch(endpoint, { cache: "no-store" });
        if (latest.ok) {
          const state = await latest.json();
          setPage((current) => ({ ...current, accounts: current.accounts.map((row) => row.id === account.id ?
            { ...row, fullAccess: state.fullAccess } : row) }));
        }
        throw new Error(body.error || "Уровень изменился. Проверьте новое значение.");
      }
      if (!response.ok) throw new Error(body.error || "Не удалось изменить доступ.");
      const saved = role ? { role: body.role as PlatformAccount["role"] } : { fullAccess: body.fullAccess as boolean };
      setPage((current) => ({ ...current, accounts: current.accounts.map((row) => row.id === account.id ? { ...row, ...saved } : row) }));
      if (account.id === currentAccountId) {
        if (role) onOwnRoleChanged(body.role); else onOwnTierChanged(body.fullAccess);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось изменить доступ."); }
    finally { setBusy(null); }
  }
  const waiting = loading || !!busy || text.trim() !== query;
  return <section className="account-card platform-accounts" aria-labelledby="platform-accounts-title">
    <div className="account-card-title"><div><span className="account-eyebrow">Платформа</span>
      <h2 id="platform-accounts-title">Пользователи</h2></div>
      <button type="button" className="platform-directory-button" onClick={() => setStatistics({ account: null })}>
        <BarChart3 size={16} aria-hidden="true" />Статистика</button>
    </div>
    <p className="account-card-copy">Глобальная роль и уровень доступа независимы. Доступ к чужому древу задаётся отдельным приглашением.</p>
    <div className="platform-account-search"><Search size={17} aria-hidden="true" />
      <input type="search" aria-label="Поиск пользователей" placeholder="Имя или ID пользователя" maxLength={160}
        disabled={!!busy} value={text} onChange={(event) => setText(event.target.value)} />
      {text && <button type="button" aria-label="Очистить поиск" disabled={!!busy} onClick={() => setText("")}><X size={16} /></button>}
    </div>
    <div className="platform-account-heading" aria-hidden="true"><span>Пользователь</span><span>Глобальная роль</span><span>Уровень доступа</span><span /></div>
    <div className="platform-account-list" aria-busy={waiting}>
      {page.accounts.map((account) => <article className="platform-account-row" key={account.id} aria-label={`Пользователь: ${account.name}`}>
        <div className="platform-account-identity"><strong>{account.name}</strong><small>{account.lastVisitAt ?
          <>Последний визит: <time dateTime={account.lastVisitAt}>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(account.lastVisitAt))}</time></> : "Последний визит не зафиксирован"}</small></div>
        <label><span className="sr-only">Роль {account.name}</span><select disabled={waiting} value={account.role || ""}
          onChange={(event) => void change(account, { role: (event.target.value || null) as PlatformAccount["role"] })}>
          <option value="">Пользователь</option><option value="researcher">Исследователь</option><option value="admin">Администратор</option></select></label>
        <label><span className="sr-only">Уровень доступа {account.name}</span><select disabled={waiting} value={account.fullAccess ? "full" : "basic"}
          onChange={(event) => void change(account, { fullAccess: event.target.value === "full" })}>
          <option value="basic">Базовый</option><option value="full">Полный</option></select></label>
        <button type="button" className="platform-directory-icon" title="Расход древа" aria-label={`Расход ${account.name}`}
          onClick={() => setStatistics({ account })}><BarChart3 size={16} aria-hidden="true" /></button>
      </article>)}
      {loading && !page.accounts.length ? <p role="status" className="platform-directory-empty">Загружаем пользователей…</p> :
        !page.accounts.length && !error && <p className="platform-directory-empty">{query ? "Пользователи не найдены." : "Пользователей пока нет."}</p>}
    </div>
    {error && <p className="form-error" role="alert">{error} <button type="button" className="platform-directory-retry"
      disabled={waiting} onClick={() => { setLoading(true); setError(""); setRefresh((value) => value + 1); }}>Обновить список</button></p>}
    <nav className="platform-account-pagination" aria-label="Страницы пользователей">
      <button type="button" className="platform-directory-button" disabled={waiting || cursors.length === 1}
        onClick={() => { setLoading(true); setError(""); setCursors((current) => current.slice(0, -1)); }}><ChevronLeft size={16} aria-hidden="true" />Назад</button>
      <span aria-live="polite">{loading ? "Загружаем…" : `Страница ${cursors.length}`}</span>
      <button type="button" className="platform-directory-button" disabled={waiting || !page.next}
        onClick={() => { setLoading(true); setError(""); setCursors((current) => [...current, page.next!]); }}>Далее<ChevronRight size={16} aria-hidden="true" /></button>
    </nav>
    {statistics && <PlatformAccountStatisticsDialog account={statistics.account} onClose={() => setStatistics(null)} />}
  </section>;
}
