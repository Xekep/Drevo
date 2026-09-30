import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useState, type FormEvent } from "react";
import { LoginButtons } from "./login-buttons";

type PublicPerson = {
  archiveId?: string;
  id: string;
  name: string;
  birthSurname?: string;
  birthYear?: string;
  deathYear?: string;
  birthPlace?: string;
  deathPlace?: string;
};

function discoveryLocation() {
  const parts = location.pathname.split("/").filter(Boolean);
  const legacy = new URLSearchParams(location.search);
  const decoded = (value?: string) => {
    try { return value ? decodeURIComponent(value) : null; }
    catch { return null; }
  };
  return {
    query: parts[1] === "search" ? decoded(parts[2]) : legacy.get("q"),
    archiveId: parts[1] === "person" && parts.length > 3 ? decoded(parts[2]) : legacy.get("archiveId"),
    personId: parts[1] === "person" ? decoded(parts.at(-1)) : legacy.get("personId"),
  };
}

function PersonCard({ person }: { person: PublicPerson }) {
  return (
    <article className="public-person-card">
      <h2>{person.name}</h2>
      {person.birthSurname && <p>Фамилия при рождении: {person.birthSurname}</p>}
      {(person.birthYear || person.deathYear) && (
        <p>
          {person.birthYear || "?"}–{person.deathYear || "?"}
        </p>
      )}
      {person.birthPlace && <p>Рождение: {person.birthPlace}</p>}
      {person.deathPlace && <p>Смерть: {person.deathPlace}</p>}
    </article>
  );
}

export default function PublicPeople() {
  const [query, setQuery] = useState(() => discoveryLocation().query || "");
  const [results, setResults] = useState<PublicPerson[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<PublicPerson | null>(null);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState(() => Boolean(discoveryLocation().query || discoveryLocation().personId));
  async function read(url: string) {
    setBusy(true);
    setError("");
    try {
      let response = await archiveFetch(url, { cache: "no-store" });
      if (response.status === 501 && url.startsWith("/api/discovery/people?"))
        response = await archiveFetch(url.replace("/api/discovery/people?", "/api/published-people/search?"), { cache: "no-store" });
      const data = await response.json();
      if (response.status === 401) setNeedsLogin(true);
      if (!response.ok) throw new Error(data.error || "Поиск недоступен");
      setNeedsLogin(false);
      return data;
    } catch (reason) {
      setError((reason as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const { personId, archiveId, query: initialQuery } = discoveryLocation();
    const url = personId
      ? archiveId
        ? `/api/discovery/people/${encodeURIComponent(archiveId)}/${encodeURIComponent(personId)}`
        : `/api/published-people/${encodeURIComponent(personId)}`
      : initialQuery
        ? `/api/discovery/people?q=${encodeURIComponent(initialQuery)}`
        : "";
    if (!url) return;
    const controller = new AbortController();
    archiveFetch(url, { cache: "no-store", signal: controller.signal })
      .then((response) =>
        response.status === 501 && url.startsWith("/api/discovery/people?")
          ? archiveFetch(url.replace("/api/discovery/people?", "/api/published-people/search?"), { cache: "no-store", signal: controller.signal })
          : response,
      )
      .then(async (response) => {
        const data = await response.json();
        if (response.status === 401) setNeedsLogin(true);
        if (!response.ok) throw new Error(data.error || "Поиск недоступен");
        if (personId) setDetail(data.person || null);
        else {
          setResults(data.results || []);
          setNextCursor(data.nextCursor || null);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message || "Поиск недоступен");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, []);
  function search(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    if (value.length < 2) {
      setError("Введите хотя бы два символа");
      return;
    }
    history.replaceState(null, "", `/discover/search/${encodeURIComponent(value)}`);
    setDetail(null);
    void read(
      `/api/discovery/people?q=${encodeURIComponent(value)}`,
    ).then((data) => {
      setResults(data?.results || []);
      setNextCursor(data?.nextCursor || null);
    });
  }
  function loadMore() {
    if (!nextCursor || busy) return;
    const value = discoveryLocation().query || query.trim();
    void read(`/api/discovery/people?q=${encodeURIComponent(value)}&cursor=${encodeURIComponent(nextCursor)}`)
      .then((data) => {
        if (!data) return;
        setResults((current) => [...current, ...(data.results || [])]);
        setNextCursor(data.nextCursor || null);
      });
  }
  return (
    <main className="public-people-page">
      <a href="/">← Древо</a>
      <h1>Поиск опубликованных людей</h1>
      <p>
        Здесь отображаются только карточки, которые администраторы архивов
        открыли для поиска.
      </p>
      <form onSubmit={search} role="search">
        <label htmlFor="public-person-query">ФИО, год или место</label>
        <div className="public-people-search-row">
          <input
            id="public-person-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={100}
          />
          <button type="submit" disabled={busy}>
            Найти
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {needsLogin && <LoginButtons />}
      {busy && <p role="status">Ищем…</p>}
      {detail && <PersonCard person={detail} />}
      {!detail && results.length > 0 && (
        <div className="public-people-results">
          {results.map((person) => (
            <a
              key={`${person.archiveId || "local"}:${person.id}`}
              href={`/discover/person/${person.archiveId ? `${encodeURIComponent(person.archiveId)}/` : ""}${encodeURIComponent(person.id)}`}
              aria-label={person.name}
            >
              <PersonCard person={person} />
            </a>
          ))}
        </div>
      )}
      {!detail && nextCursor && (
        <button type="button" disabled={busy} onClick={loadMore}>
          Показать ещё
        </button>
      )}
      {!detail &&
        !busy &&
        !error &&
        !!discoveryLocation().query &&
        results.length === 0 && <p>Никого не найдено.</p>}
    </main>
  );
}
