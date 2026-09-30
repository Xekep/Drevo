import { useEffect, useMemo, useState } from "react";
import type { Family, Person } from "../domain/types.ts";
import { fullName } from "../domain/dates.ts";
import { archiveFetch } from "../data/archive-fetch.ts";
import { defaultPublicationFields, type PublicationFields } from "../shared/publication.ts";
import "../styles/publication-admin.css";

const PAGE_SIZE = 20;
const endpoint = "/api/admin/published-people/batch";
const publishable = (person: Person) => person.deceased === true || Boolean(person.death);
const year = (value?: string) => value?.match(/\b\d{4}\b/)?.[0];

export function PublicationAdmin({ family }: { family: Family }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, PublicationFields>>({});
  const [fields, setFields] = useState<PublicationFields>(defaultPublicationFields);
  const [confirm, setConfirm] = useState<"publish" | "unpublish" | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const people = useMemo(() => family.people.filter(publishable)
    .sort((a, b) => fullName(a).localeCompare(fullName(b), "ru") || a.id.localeCompare(b.id)), [family.people]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("ru-RU");
    return term ? people.filter((person) =>
      `${fullName(person)} ${person.maidenName || ""}`.toLocaleLowerCase("ru-RU").includes(term)) : people;
  }, [people, query]);
  const pagePeople = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const chosen = [...selected].map((id) => peopleById.get(id)).filter((person): person is Person => Boolean(person));
  const pageIds = pagePeople.map((person) => person.id);
  const pageKey = pageIds.join("\0");

  useEffect(() => {
    if (!pageKey) return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    pageKey.split("\0").forEach((id) => params.append("id", id));
    archiveFetch(`${endpoint}?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Не удалось загрузить публикации");
        setStatuses((current) => {
          const next = { ...current };
          pageKey.split("\0").forEach((id) => delete next[id]);
          return { ...next, ...body.fields };
        });
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [pageKey, reload]);

  function select(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
    setConfirm(null);
  }

  async function apply() {
    if (!confirm || !chosen.length) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await archiveFetch(endpoint, {
        method: confirm === "publish" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personIds: chosen.map((person) => person.id), fields }),
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
      setConfirm(null);
      setReload((value) => value + 1);
    } catch (reason) { setError((reason as Error).message); }
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
    <p>В общий поиск попадают только подтверждённо умершие люди, которых вы выберете. Фото, связи, документы и точные даты останутся закрытыми.</p>
    <label>Найти человека
      <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="ФИО или фамилия при рождении" />
    </label>
    <div className="publication-admin-toolbar">
      <span>{filtered.length} человек · выбрано {chosen.length} из 50</span>
      <button type="button" disabled={!pagePeople.length || chosen.length + pageIds.filter((id) => !selected.has(id)).length > 50}
        onClick={() => { setSelected((current) => new Set([...current, ...pageIds])); setConfirm(null); }}>
        Выбрать страницу
      </button>
      <button type="button" disabled={!chosen.length} onClick={() => { setSelected(new Set()); setConfirm(null); }}>Сбросить</button>
    </div>
    <div className="publication-admin-list" aria-label="Люди для публикации">
      {pagePeople.map((person) => <label key={person.id} className="publication-admin-row">
        <input type="checkbox" checked={selected.has(person.id)} disabled={busy || (!selected.has(person.id) && chosen.length >= 50)}
          onChange={(event) => select(person.id, event.target.checked)} />
        <span><strong>{fullName(person)}</strong><small>{[year(person.birth), year(person.death)].filter(Boolean).join("–") || "Годы не указаны"}</small></span>
        <span className="publication-admin-state">{statuses[person.id] ? "Можно найти" : "Скрыт"}</span>
      </label>)}
      {!pagePeople.length && <p>Подходящих людей нет.</p>}
    </div>
    {filtered.length > PAGE_SIZE && <nav className="publication-admin-pages" aria-label="Страницы людей">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Назад</button>
      <span>Страница {page + 1} из {Math.ceil(filtered.length / PAGE_SIZE)}</span>
      <button type="button" disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(page + 1)}>Далее</button>
    </nav>}
    {chosen.length > 0 && <div className="publication-admin-actions">
      <button type="button" disabled={busy} onClick={() => setConfirm("publish")}>Опубликовать выбранных</button>
      <button type="button" disabled={busy} onClick={() => setConfirm("unpublish")}>Снять выбранных с поиска</button>
    </div>}
    {confirm && <section className="publication-admin-confirm" aria-label="Проверка публикации">
      <h2>{confirm === "publish" ? "Проверьте публикацию" : "Проверьте отзыв публикации"}</h2>
      {confirm === "publish" && <fieldset><legend>Какие поля открыть</legend>
        <p>ФИО публикуется обязательно. Отсутствующее у человека значение не появится в поиске позднее без нового разрешения.</p>
        {availableFields.map(({ key, label }) => <label key={key} className="publication-field">
          <input type="checkbox" checked={fields[key]} onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.checked }))} />{label}
        </label>)}
      </fieldset>}
      <ul>{chosen.map((person) => <li key={person.id}>
        <strong>{fullName(person)}</strong>
        {confirm === "publish" && <span>{[
          fields.birthSurname && person.maidenName && `при рождении ${person.maidenName}`,
          fields.birthYear && year(person.birth) && `р. ${year(person.birth)}`,
          fields.deathYear && year(person.death) && `ум. ${year(person.death)}`,
          fields.birthPlace && person.birthPlace && `рождение: ${person.birthPlace}`,
          fields.deathPlace && person.deathPlace && `смерть: ${person.deathPlace}`,
        ].filter(Boolean).join(" · ")}</span>}
      </li>)}</ul>
      <div className="publication-admin-actions">
        <button type="button" className="primary-action" disabled={busy} onClick={() => void apply()}>
          {busy ? "Сохраняем…" : confirm === "publish" ? `Подтвердить публикацию ${chosen.length}` : `Подтвердить отзыв ${chosen.length}`}
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirm(null)}>Отмена</button>
      </div>
    </section>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
