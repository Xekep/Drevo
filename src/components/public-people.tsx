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
  const [linkedCards, setLinkedCards] = useState<PublicPerson[]>([]);
  const [linkedCardsTruncated, setLinkedCardsTruncated] = useState(false);
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
    let controller: AbortController | null = null;
    let request = 0;
    function load() {
      controller?.abort();
      controller = new AbortController();
      const currentController = controller;
      const currentRequest = ++request;
      setError("");
      setNeedsLogin(false);
      setBusy(true);
      if (personId) {
        setDetail(null);
        setLinkedCards([]);
        setLinkedCardsTruncated(false);
      }
      archiveFetch(url, { cache: "no-store", signal: currentController.signal })
        .then((response) =>
          response.status === 501 && url.startsWith("/api/discovery/people?")
            ? archiveFetch(url.replace("/api/discovery/people?", "/api/published-people/search?"), { cache: "no-store", signal: currentController.signal })
            : response,
        )
        .then(async (response) => {
          const data = await response.json();
          if (currentController.signal.aborted || currentRequest !== request) return;
          if (response.status === 401) setNeedsLogin(true);
          if (!response.ok) throw new Error(data.error || "Поиск недоступен");
          if (personId) {
            setDetail(data.person || null);
            setLinkedCards(data.linkedCards || []);
            setLinkedCardsTruncated(Boolean(data.linkedCardsTruncated));
          }
          else {
            setResults(data.results || []);
            setNextCursor(data.nextCursor || null);
          }
        })
        .catch((reason) => {
          if (!currentController.signal.aborted && currentRequest === request)
            setError(reason.message || "Поиск недоступен");
        })
        .finally(() => {
          if (!currentController.signal.aborted && currentRequest === request) setBusy(false);
        });
    }
    const recheck = () => {
      if (personId && document.visibilityState === "visible" &&
        discoveryLocation().personId === personId && discoveryLocation().archiveId === archiveId) load();
    };
    load();
    if (personId) {
      window.addEventListener("focus", recheck);
      document.addEventListener("visibilitychange", recheck);
    }
    return () => {
      request += 1;
      controller?.abort();
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
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
    setLinkedCards([]);
    setLinkedCardsTruncated(false);
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
      {detail && linkedCards.length > 0 && <section className="public-people-linked">
        <h2>Этот человек в других деревьях</h2>
        <p>Владельцы обоих деревьев подтвердили соответствие карточек. Доступны только опубликованные сведения.</p>
        <div className="public-people-results">
          {linkedCards.map((person) => <a key={`${person.archiveId}:${person.id}`}
            href={`/discover/person/${encodeURIComponent(person.archiveId || "")}/${encodeURIComponent(person.id)}`}
            aria-label={person.name}>
            <PersonCard person={person} />
          </a>)}
        </div>
        {linkedCardsTruncated && <p>Показаны первые 50 связанных карточек.</p>}
      </section>}
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
