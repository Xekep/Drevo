import { useEffect, useState, type FormEvent } from "react";
import { LoginButtons } from "./login-buttons";

type PublicPerson = {
  id: string;
  name: string;
  birthYear?: string;
  deathYear?: string;
  birthPlace?: string;
  deathPlace?: string;
};

function PersonCard({ person }: { person: PublicPerson }) {
  return (
    <article className="public-person-card">
      <h2>{person.name}</h2>
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
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get("q") || "");
  const [results, setResults] = useState<PublicPerson[]>([]);
  const [detail, setDetail] = useState<PublicPerson | null>(null);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState(() => Boolean(new URLSearchParams(location.search).get("q") || new URLSearchParams(location.search).get("personId")));
  async function read(url: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, { cache: "no-store" });
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
    const initial = new URLSearchParams(location.search);
    const personId = initial.get("personId");
    const initialQuery = initial.get("q");
    const url = personId
      ? `/api/published-people/${encodeURIComponent(personId)}`
      : initialQuery
        ? `/api/published-people/search?q=${encodeURIComponent(initialQuery)}`
        : "";
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (response.status === 401) setNeedsLogin(true);
        if (!response.ok) throw new Error(data.error || "Поиск недоступен");
        if (personId) setDetail(data.person || null);
        else setResults(data.results || []);
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
    history.replaceState(null, "", `/discover?q=${encodeURIComponent(value)}`);
    setDetail(null);
    void read(
      `/api/published-people/search?q=${encodeURIComponent(value)}`,
    ).then((data) => setResults(data?.results || []));
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
              key={person.id}
              href={`/discover?personId=${encodeURIComponent(person.id)}`}
            >
              <PersonCard person={person} />
            </a>
          ))}
        </div>
      )}
      {!detail &&
        !busy &&
        !error &&
        new URLSearchParams(location.search).has("q") &&
        results.length === 0 && <p>Никого не найдено.</p>}
    </main>
  );
}
