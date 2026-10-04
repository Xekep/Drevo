import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LoginButtons } from "./login-buttons";
import { adminMatchTargetPath } from "../domain/archive-routes.ts";

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
type OwnedArchive = { id: string; title: string; role: string; approved: boolean; owned: boolean };

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
  const [matchArchives, setMatchArchives] = useState<OwnedArchive[]>([]);
  const [matchArchivesError, setMatchArchivesError] = useState("");
  const [linkedCards, setLinkedCards] = useState<PublicPerson[]>([]);
  const [linkedCardsTruncated, setLinkedCardsTruncated] = useState(false);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState(() => Boolean(discoveryLocation().query || discoveryLocation().personId));
  const request = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  useEffect(() => {
    if (!detail?.archiveId) return;
    const controller = new AbortController();
    void archiveFetch("/api/account/archives", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 501) return null;
        if (!response.ok) throw new Error("Не удалось проверить ваши древа для сопоставления");
        return response.json() as Promise<{ archives: OwnedArchive[] }>;
      })
      .then((data) => {
        if (!controller.signal.aborted && data) setMatchArchives(data.archives.filter((archive) =>
          archive.owned && archive.approved && archive.id !== detail.archiveId));
      })
      .catch(() => {
        if (!controller.signal.aborted) setMatchArchivesError("Не удалось проверить ваши древа для сопоставления");
      });
    return () => controller.abort();
  }, [detail?.archiveId, detail?.id]);
  async function read(url: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++requestVersion.current;
    setBusy(true);
    setError("");
    setNeedsLogin(false);
    try {
      let response = await archiveFetch(url, { cache: "no-store", signal: controller.signal });
      if (response.status === 501 && url.startsWith("/api/discovery/people?"))
        response = await archiveFetch(url.replace("/api/discovery/people?", "/api/published-people/search?"),
          { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (controller.signal.aborted || version !== requestVersion.current) return null;
      if (response.status === 401) setNeedsLogin(true);
      if (!response.ok) throw new Error(data.error || "Поиск недоступен");
      setNeedsLogin(false);
      return data;
    } catch (reason) {
      if (!controller.signal.aborted && version === requestVersion.current)
        setError((reason as Error).message);
      return null;
    } finally {
      if (!controller.signal.aborted && version === requestVersion.current) setBusy(false);
    }
  }
  useEffect(() => {
    function load() {
      const { personId, archiveId, query: currentQuery } = discoveryLocation();
      const url = personId
        ? archiveId
          ? `/api/discovery/people/${encodeURIComponent(archiveId)}/${encodeURIComponent(personId)}`
          : `/api/published-people/${encodeURIComponent(personId)}`
        : currentQuery
          ? `/api/discovery/people?q=${encodeURIComponent(currentQuery)}`
          : "";
      if (!url) return;
      setDetail(null);
      setMatchArchives([]);
      setMatchArchivesError("");
      setLinkedCards([]);
      setLinkedCardsTruncated(false);
      setResults([]);
      setNextCursor(null);
      void read(url).then((data) => {
        if (!data) return;
        if (personId) {
          setDetail(data.person || null);
          setLinkedCards(data.linkedCards || []);
          setLinkedCardsTruncated(Boolean(data.linkedCardsTruncated));
        } else {
          setResults(data.results || []);
          setNextCursor(data.nextCursor || null);
        }
      });
    }
    const recheck = () => { if (document.visibilityState === "visible") load(); };
    load();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      requestVersion.current += 1;
      request.current?.abort();
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
    setMatchArchives([]);
    setMatchArchivesError("");
    setLinkedCards([]);
    setLinkedCardsTruncated(false);
    void read(
      `/api/discovery/people?q=${encodeURIComponent(value)}`,
    ).then((data) => {
      if (!data) return;
      setResults(data.results || []);
      setNextCursor(data.nextCursor || null);
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
      {detail?.archiveId && matchArchives.length > 0 && <section className="public-people-match">
        <h2>Предложить связь с моей карточкой</h2>
        <p>Выберите своё древо и сравните две опубликованные карточки перед отправкой запроса. Связь появится только после подтверждения другой стороны.</p>
        {matchArchives.map((archive) => <a key={archive.id}
          href={adminMatchTargetPath(archive.id, { archiveId: detail.archiveId!, personId: detail.id })}>
          Открыть сопоставление в древе «{archive.title}»
        </a>)}
      </section>}
      {detail && matchArchivesError && <p role="status">{matchArchivesError}</p>}
      {detail && linkedCards.length > 0 && <section className="public-people-linked">
        <h2>Этот человек в других древах</h2>
        <p>Владельцы обоих древ подтвердили соответствие карточек. Доступны только опубликованные сведения.</p>
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
