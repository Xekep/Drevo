import { useCallback, useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import "../styles/invitations-admin.css";
import { PersonSearch } from "./person-search";
import { fullName, type Person, type TreeAccess } from "../domain";

type Invitation = {
  id: string;
  role: "reader" | "relative";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  personId?: string | null;
  treeAccess?: TreeAccess;
};

export function InvitationsAdmin({ people }: { people: Person[] }) {
  const [items, setItems] = useState<Invitation[]>([]);
  const [role, setRole] = useState<Invitation["role"]>("reader");
  const [hours, setHours] = useState(168);
  const [personId, setPersonId] = useState("");
  const [treeAccess, setTreeAccess] = useState<TreeAccess>("all");
  const [createdLink, setCreatedLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await archiveFetch("/api/invitations", {
      signal,
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Не удалось загрузить приглашения.");
    setItems(result.invitations);
    setLoaded(true);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void archiveFetch("/api/invitations", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Не удалось загрузить приглашения.");
        if (!controller.signal.aborted) {
          setItems(result.invitations);
          setLoaded(true);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      });
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          durationHours: hours,
          personId: personId || null,
          treeAccess: personId ? treeAccess : "all",
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Не удалось создать приглашение.");
      const address = new URL(result.path, location.origin).href;
      setCreatedLink(address);
      await load();
      if (navigator.clipboard)
        await navigator.clipboard.writeText(address).catch(() => {});
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await archiveFetch(`/api/invitations/${id}`, {
        method: "DELETE",
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).error || "Не удалось отозвать приглашение.",
        );
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-card invitations-admin">
      <h2>Пригласить в древо</h2>
      <p>
        Одноразовая ссылка открывает доступ только к этому архиву. Первый
        вошедший участник принимает приглашение.
      </p>
      <div className="invitations-controls">
        <PersonSearch
          label="Кто это в древе"
          value={personId}
          selected={people.find((person) => person.id === personId)}
          people={people}
          disabled={busy}
          onChange={(id) => {
            setPersonId(id);
            if (!id) setTreeAccess("all");
          }}
        />
        {personId && (
          <label>
            Доступ к древу
            <select
              aria-label="Доступ к древу"
              value={treeAccess}
              disabled={busy}
              onChange={(event) =>
                setTreeAccess(event.target.value as TreeAccess)
              }
            >
              <option value="all">Всё древо</option>
              <option value="common_ancestors">Кровные родственники</option>
            </select>
            <small>Кровные родственники и их супруги или партнёры.</small>
          </label>
        )}
        <label>
          Роль
          <select
            aria-label="Роль"
            value={role}
            onChange={(event) =>
              setRole(event.target.value as Invitation["role"])
            }
          >
            <option value="reader">Читатель</option>
            <option value="relative">Родственник</option>
          </select>
        </label>
        <label>
          Срок
          <select
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          >
            <option value={24}>1 день</option>
            <option value={168}>1 неделя</option>
            <option value={720}>30 дней</option>
          </select>
        </label>
        <button
          type="button"
          className="primary-action"
          disabled={busy}
          onClick={() => void create()}
        >
          Создать ссылку
        </button>
      </div>
      {createdLink && (
        <label className="invitations-created">
          Ссылка для отправки
          <input
            readOnly
            value={createdLink}
            onFocus={(event) => event.target.select()}
          />
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <h3>Выданные приглашения</h3>
      {!loaded && !error && <p role="status">Загружаем приглашения…</p>}
      {loaded && !items.length && (
        <p className="muted-copy">Приглашений пока нет.</p>
      )}
      <div className="invitations-list">
        {items.map((item) => {
          const active =
            !item.revokedAt && !item.usedAt && Date.parse(item.expiresAt) > now;
          const status = item.revokedAt
            ? "Отозвано"
            : item.usedAt
              ? "Принято"
              : active
                ? "Ожидает"
                : "Истекло";
          return (
            <div className="invitations-row" key={item.id}>
              <span>
                <strong>
                  {item.role === "reader" ? "Читатель" : "Родственник"}
                </strong>
                <small>
                  до {new Date(item.expiresAt).toLocaleString("ru-RU")}
                </small>
                <small>
                  {item.treeAccess === "common_ancestors"
                    ? "Кровные родственники и партнёры"
                    : "Всё древо"}
                  {item.personId &&
                  people.some((person) => person.id === item.personId)
                    ? ` · ${fullName(people.find((person) => person.id === item.personId)!)}`
                    : ""}
                </small>
              </span>
              <span
                className={
                  active ? "invitations-status active" : "invitations-status"
                }
              >
                {status}
              </span>
              {active && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(item.id)}
                >
                  Отозвать
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
