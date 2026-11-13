import { useEffect, useMemo, useRef, useState } from "react";
import type { Family, Person } from "../domain/types.ts";
import { fullName } from "../domain/dates.ts";
import { archiveFetch } from "../data/archive-fetch.ts";
import { defaultPublicationFields, type PublicationFields } from "../shared/publication.ts";
import "../styles/publication-admin.css";

const PAGE_SIZE = 20;
const endpoint = "/api/admin/published-people/batch";
const publishable = (person: Person) => person.deceased === true || Boolean(person.death);
const year = (value?: string) => value?.match(/\b\d{4}\b/)?.[0];
type BatchReview = {
  revision: number;
  reviewToken: string;
  people: { id: string; published: boolean; person: {
    name: string; birthSurname?: string; birthYear?: string; deathYear?: string;
    birthPlace?: string; deathPlace?: string;
  } }[];
};

export function PublicationAdmin({ family }: { family: Family }) {
  const [mode, setMode] = useState<"published" | "add">("published");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, PublicationFields>>({});
  const [loadedStatusKey, setLoadedStatusKey] = useState("");
  const [failedStatusKey, setFailedStatusKey] = useState("");
  const [statusError, setStatusError] = useState("");
  const [fields, setFields] = useState<PublicationFields>(defaultPublicationFields);
  const [confirm, setConfirm] = useState<"publish" | "unpublish" | null>(null);
  const [review, setReview] = useState<{ data: BatchReview; family: Family } | null>(null);
  const reviewRequest = useRef(0);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const people = useMemo(() => family.people.filter(publishable)
    .filter(person => mode === "published" ? Boolean(statuses[person.id]) : !statuses[person.id])
    .sort((a, b) => fullName(a).localeCompare(fullName(b), "ru") || a.id.localeCompare(b.id)), [family.people, statuses, mode]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("ru-RU");
    return term ? people.filter((person) =>
      `${fullName(person)} ${person.maidenName || ""}`.toLocaleLowerCase("ru-RU").includes(term)) : people;
  }, [people, query]);
  const activePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const pagePeople = filtered.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE);
  const peopleById = useMemo(() => new Map(family.people.filter(publishable).map((person) => [person.id, person])), [family.people]);
  const chosen = [...selected].map((id) => peopleById.get(id)).filter((person): person is Person => Boolean(person));
  const pageIds = pagePeople.map((person) => person.id);
  const statusKey = String(reload);
  const statusesReady = loadedStatusKey === statusKey;
  const statusFor = (id: string) => !statusesReady
    ? failedStatusKey === statusKey ? "Не удалось проверить" : "Проверяем…"
    : statuses[id] ? "Можно найти" : "Скрыт";
  const validReview = review?.family === family ? review.data : null;

  useEffect(() => {
    const recheck = () => {
      if (!document.hidden) setReload((value) => value + 1);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    archiveFetch(`${endpoint}?published=1`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(body.error || "Не удалось загрузить публикации");
        setStatuses(body.fields);
        setLoadedStatusKey(statusKey);
        setFailedStatusKey("");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setFailedStatusKey(statusKey);
          setStatusError(reason.message);
        }
      });
    return () => controller.abort();
  }, [family, reload, statusKey]);

  function select(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
    setConfirm(null);
    setReview(null);
    reviewRequest.current += 1;
  }

  async function openReview(action: "publish" | "unpublish") {
    if (!chosen.length || !statusesReady || busy) return;
    const requestId = ++reviewRequest.current;
    setBusy(true);
    setConfirm(null);
    setReview(null);
    setError("");
    setNotice("");
    try {
      const response = await archiveFetch(`${endpoint}/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, personIds: chosen.map((person) => person.id), fields }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось проверить публикацию");
      if (requestId === reviewRequest.current) {
        setReview({ data: body as BatchReview, family });
        setConfirm(action);
      }
    } catch (reason) {
      if (requestId === reviewRequest.current) setError((reason as Error).message);
    } finally {
      if (requestId === reviewRequest.current) setBusy(false);
    }
  }

  async function apply() {
    if (!confirm || !validReview || !chosen.length || !statusesReady) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await archiveFetch(endpoint, {
        method: confirm === "publish" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personIds: chosen.map((person) => person.id), fields,
          revision: validReview.revision, reviewToken: validReview.reviewToken }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось изменить публикации");
      setNotice(confirm === "publish" ? `Опубликовано карточек: ${body.count}` : `Снято с поиска: ${body.count}`);
      setStatuses((current) => {
        const next = { ...current };
        chosen.forEach((person) => {
          if (confirm === "publish") next[person.id] = fields;
          else delete next[person.id];
        });
        return next;
      });
      setSelected(new Set());
      setMode("published");
      setPage(0);
      setConfirm(null);
      setReview(null);
      setReload((value) => value + 1);
    } catch (reason) {
      setError((reason as Error).message);
      setConfirm(null);
      setReview(null);
    }
    finally { setBusy(false); }
  }

  const availableFields = [
    { key: "birthSurname", label: "Фамилия при рождении" },
    { key: "birthYear", label: "Год рождения" },
    { key: "deathYear", label: "Год смерти" },
    { key: "birthPlace", label: "Место рождения" },
    { key: "deathPlace", label: "Место смерти" },
  ] as const;
  return <section className="admin-card archive-form publication-admin">
    <div className="publication-admin-toolbar">
      <p>{mode === "published" ? "Здесь только люди, которых уже можно найти в общем поиске Drevo."
        : "Выберите подтверждённо умерших людей для добавления в поиск. Фото, связи и документы остаются закрытыми."}</p>
      <button type="button" disabled={busy} onClick={() => {
        setMode(mode === "published" ? "add" : "published"); setPage(0); setQuery("");
        setSelected(new Set()); setConfirm(null); setReview(null); reviewRequest.current += 1;
      }}>{mode === "published" ? "Добавить в поиск" : "К опубликованным"}</button>
    </div>
    <label>Найти человека
      <input type="search" value={query} onChange={(event) => {
        setQuery(event.target.value);
        setPage(0);
      }} placeholder="ФИО или фамилия при рождении" />
    </label>
    <div className="publication-admin-toolbar">
      <span>{filtered.length} человек · выбрано {chosen.length} из 50</span>
      <button type="button" disabled={busy || !statusesReady || !pagePeople.length || chosen.length + pageIds.filter((id) => !selected.has(id)).length > 50}
        onClick={() => { setSelected((current) => new Set([...current, ...pageIds])); setConfirm(null); setReview(null); reviewRequest.current += 1; }}>
        Выбрать страницу
      </button>
      <button type="button" disabled={busy || !chosen.length} onClick={() => { setSelected(new Set()); setConfirm(null); setReview(null); reviewRequest.current += 1; }}>Сбросить</button>
      {failedStatusKey === statusKey && <button type="button" onClick={() => setReload((value) => value + 1)}>Повторить проверку</button>}
    </div>
    {!statusesReady && failedStatusKey !== statusKey && <p role="status">Загружаем публикации…</p>}
    <div className="publication-admin-list" aria-label={mode === "published" ? "Опубликованные люди" : "Люди для публикации"}>
      {pagePeople.map((person) => <label key={person.id} className="publication-admin-row">
        <input type="checkbox" checked={selected.has(person.id)} disabled={busy || !statusesReady || (!selected.has(person.id) && chosen.length >= 50)}
          onChange={(event) => select(person.id, event.target.checked)} />
        <span><strong>{fullName(person)}</strong><small>{[year(person.birth), year(person.death)].filter(Boolean).join("–") || "Годы не указаны"}</small></span>
        <span className="publication-admin-state">{statusFor(person.id)}</span>
      </label>)}
      {statusesReady && !pagePeople.length && <p>{mode === "published" && !query.trim() ? "Опубликованных людей пока нет." : "Подходящих людей нет."}</p>}
    </div>
    {filtered.length > PAGE_SIZE && <nav className="publication-admin-pages" aria-label="Страницы людей">
      <button type="button" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>Назад</button>
      <span>Страница {activePage + 1} из {Math.ceil(filtered.length / PAGE_SIZE)}</span>
      <button type="button" disabled={(activePage + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(activePage + 1)}>Далее</button>
    </nav>}
    {chosen.length > 0 && <fieldset className="publication-admin-fields"><legend>Какие поля открыть при публикации</legend>
        <p>ФИО публикуется обязательно. Отсутствующее у человека значение не появится в поиске позднее без нового разрешения.</p>
        {availableFields.map(({ key, label }) => <label key={key} className="publication-field">
          <input type="checkbox" checked={fields[key]} disabled={busy} onChange={(event) => {
            setFields((current) => ({ ...current, [key]: event.target.checked }));
            setConfirm(null); setReview(null); reviewRequest.current += 1;
          }} />{label}
        </label>)}
    </fieldset>}
    {chosen.length > 0 && <div className="publication-admin-actions">
      <button type="button" disabled={busy || !statusesReady} onClick={() => void openReview("publish")}>{mode === "published" ? "Изменить публикацию" : "Опубликовать выбранных"}</button>
      {mode === "published" && <button type="button" disabled={busy || !statusesReady} onClick={() => void openReview("unpublish")}>Снять выбранных с поиска</button>}
    </div>}
    {confirm && validReview && <section className="publication-admin-confirm" aria-label="Проверка публикации">
      <h2>{confirm === "publish" ? "Проверьте публикацию" : "Проверьте отзыв публикации"}</h2>
      <p>Данные проверены сервером для версии архива {validReview.revision}. Если карточки или публикации изменятся, потребуется новый предпросмотр.</p>
      <ul>{validReview.people.map((item) => <li key={item.id}>
        <strong>{item.person.name}</strong>
        <span>{item.published ? "Сейчас можно найти" : "Сейчас скрыт"}</span>
        <span>{[
          item.person.birthSurname && `при рождении ${item.person.birthSurname}`,
          item.person.birthYear && `р. ${item.person.birthYear}`,
          item.person.deathYear && `ум. ${item.person.deathYear}`,
          item.person.birthPlace && `рождение: ${item.person.birthPlace}`,
          item.person.deathPlace && `смерть: ${item.person.deathPlace}`,
        ].filter(Boolean).join(" · ")}</span>
      </li>)}</ul>
      <div className="publication-admin-actions">
        <button type="button" className="primary-action" disabled={busy || !statusesReady} onClick={() => void apply()}>
          {busy ? "Сохраняем…" : confirm === "publish" ? `Подтвердить публикацию ${chosen.length}` : `Подтвердить отзыв ${chosen.length}`}
        </button>
        <button type="button" disabled={busy} onClick={() => { setConfirm(null); setReview(null); }}>Отмена</button>
      </div>
    </section>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {failedStatusKey === statusKey && <p role="alert" className="form-error">{statusError}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
