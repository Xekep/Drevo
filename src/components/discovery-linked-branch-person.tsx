import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { adminMatchesPath } from "../domain/archive-routes.ts";

type Person = { archiveId: string; id: string; name: string;
  relation: "parent" | "child" | "spouse"; birthYear?: string; deathYear?: string;
  birthPlace?: string; deathPlace?: string };
const relationLabels = { parent: "Родитель", child: "Ребёнок", spouse: "Супруг(а)" };

/** A direct URL always reloads one selected, mutually permitted projection. */
export function DiscoveryLinkedBranchPerson({ archiveId, matchId, personId }: {
  archiveId: string; matchId: string; personId: string;
}) {
  const [person, setPerson] = useState<Person | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const endpoint = `/a/${encodeURIComponent(archiveId)}/api/discovery/matches/${matchId}/branch-share/people/${encodeURIComponent(personId)}`;
  useEffect(() => {
    let request = 0;
    let active = true;
    async function load() {
      const current = ++request;
      setPerson(null); setError(""); setBusy(true);
      try {
        const response = await archiveFetch(endpoint, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Карточка недоступна");
        if (active && current === request) setPerson(body.person);
      } catch (reason) {
        if (active && current === request) setError((reason as Error).message);
      } finally {
        if (active && current === request) setBusy(false);
      }
    }
    const recheck = () => { if (document.visibilityState === "visible") void load(); };
    void load();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => { active = false; window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck); };
  }, [endpoint]);
  return <main className="public-people-page">
    <a href={`/a/${encodeURIComponent(archiveId)}${adminMatchesPath}`}>← К сопоставлениям</a>
    <h1>Разрешённая карточка другого архива</h1>
    <p>Показаны только опубликованные сведения выбранного прямого родственника. Просмотр требует действующего разрешения владельцев обоих архивов.</p>
    {busy && <p role="status">Проверяем доступ…</p>}
    {error && <p role="alert">{error}</p>}
    {person && <article className="public-person-card">
      <h2>{person.name}</h2>
      <p>{relationLabels[person.relation]} · Архив: {person.archiveId}</p>
      {(person.birthYear || person.deathYear) &&
        <p>{person.birthYear || "?"}–{person.deathYear || "?"}</p>}
      {person.birthPlace && <p>Рождение: {person.birthPlace}</p>}
      {person.deathPlace && <p>Смерть: {person.deathPlace}</p>}
    </article>}
  </main>;
}
