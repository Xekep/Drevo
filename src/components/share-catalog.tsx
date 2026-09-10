import { useEffect, useState } from "react";
import type { ShareLink } from "../domain/shared-family";
export function ShareCatalog() {
  const [items, setItems] = useState<ShareLink[]>([]),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/shares", { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        setItems(data.items);
        setNext(data.next);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  async function revoke(id: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/shares/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error((await r.json()).error);
      setItems((old) =>
        old.map((s) =>
          s.id === id ? { ...s, revokedAt: new Date().toISOString() } : s,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/shares?before=${encodeURIComponent(next!)}`),
        data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setItems((old) => [...old, ...data.items]);
      setNext(data.next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="admin-card share-catalog">
      <h2>Временные ссылки</h2>
      <p>
        Создавайте ссылки на древе в режиме «Семья выбранного». Здесь видны все
        выдачи, включая истёкшие и отозванные.
      </p>
      {!items.length && <p className="muted-copy">Выданных ссылок пока нет.</p>}
      {items.map((s) => {
        const active = !s.revokedAt && Date.parse(s.expiresAt) > now;
        return (
          <article key={s.id}>
            <div>
              <strong>{s.title}</strong>
              <small>
                {s.personIds.length} человек · Выдал: {s.createdName}
              </small>
              <small>
                Создана: {new Date(s.createdAt).toLocaleString("ru-RU")}
              </small>
              <small>До: {new Date(s.expiresAt).toLocaleString("ru-RU")}</small>
            </div>
            <span className={active ? "share-active" : "muted-copy"}>
              {s.revokedAt ? "Отозвана" : active ? "Действует" : "Истекла"}
            </span>
            {active && (
              <button disabled={busy} onClick={() => void revoke(s.id)}>
                Отозвать
              </button>
            )}
          </article>
        );
      })}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {next && (
        <button disabled={busy} onClick={() => void more()}>
          Показать ещё
        </button>
      )}
    </section>
  );
}
