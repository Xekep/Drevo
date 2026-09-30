import { useEffect, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import "../styles/discovery-matches-admin.css";

type Candidate = {
  archiveId: string;
  id: string;
  name?: string;
  birthSurname?: string;
  birthYear?: string;
  deathYear?: string;
  birthPlace?: string;
  deathPlace?: string;
};
type Match = {
  id: string;
  status: "pending" | "linked" | "rejected" | "revoked";
  initiatedByArchiveId: string;
  requestedAt: string;
  left: Candidate;
  right: Candidate;
};
const endpoint = "/api/discovery/matches";
const statusLabel: Record<Match["status"], string> = {
  pending: "Ожидает подтверждения",
  linked: "Сопоставлено",
  rejected: "Отклонено",
  revoked: "Связь отозвана",
};

function CandidateCard({ candidate }: { candidate: Candidate }) {
  return <div className="match-candidate-card">
    {candidate.name ? <a href={`/discover/person/${encodeURIComponent(candidate.archiveId)}/${encodeURIComponent(candidate.id)}`}>
      <strong>{candidate.name}</strong>
    </a> : <strong>Карточка больше не опубликована</strong>}
    {candidate.birthSurname && <small>При рождении: {candidate.birthSurname}</small>}
    {(candidate.birthYear || candidate.deathYear) && <small>{candidate.birthYear || "?"}–{candidate.deathYear || "?"}</small>}
    {candidate.birthPlace && <small>Рождение: {candidate.birthPlace}</small>}
    {candidate.deathPlace && <small>Смерть: {candidate.deathPlace}</small>}
  </div>;
}

export function DiscoveryMatchesAdmin() {
  const [archiveId, setArchiveId] = useState("");
  const [ownQuery, setOwnQuery] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [ownPeople, setOwnPeople] = useState<Candidate[]>([]);
  const [targets, setTargets] = useState<Candidate[]>([]);
  const [source, setSource] = useState<Candidate | null>(null);
  const [target, setTarget] = useState<Candidate | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      archiveFetch(`${endpoint}/own-people?q=${encodeURIComponent(ownQuery.trim())}`, {
        signal: controller.signal, cache: "no-store",
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Не удалось загрузить своих людей");
        setArchiveId(body.archiveId);
        setOwnPeople(body.people);
      }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [ownQuery, reload]);

  useEffect(() => {
    if (targetQuery.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      archiveFetch(`/api/discovery/people?q=${encodeURIComponent(targetQuery.trim())}`, {
        signal: controller.signal, cache: "no-store",
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Не удалось найти карточки");
        setTargets(body.results);
      }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [targetQuery]);

  useEffect(() => {
    const controller = new AbortController();
    archiveFetch(`${endpoint}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
      signal: controller.signal, cache: "no-store",
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось загрузить сопоставления");
      setArchiveId(body.archiveId);
      setMatches(body.matches);
      setNextCursor(body.nextCursor);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [cursor, reload]);

  async function send() {
    if (!source || !target) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await archiveFetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePersonId: source.id, targetArchiveId: target.archiveId, targetPersonId: target.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось отправить запрос");
      setNotice(body.match.status === "pending" ? "Запрос отправлен. Другая сторона должна подтвердить сопоставление." :
        "Этот запрос уже существует. Его текущий статус показан ниже.");
      setSource(null); setTarget(null); setCursor(null); setHistory([]);
      setReload((value) => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function decide(id: string, decision: "accept" | "reject" | "revoke") {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await archiveFetch(`${endpoint}/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось изменить решение");
      setNotice(decision === "accept" ? "Сопоставление подтверждено." :
        decision === "reject" ? "Запрос отклонён." : "Связь отозвана.");
      setReload((value) => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="discovery-matches-admin">
    <section className="admin-card archive-form">
      <p>Сопоставление подтверждает, что две опубликованные карточки описывают одного человека. Оно не объединяет деревья и не открывает чужую ветку.</p>
      <div className="match-search-grid">
        <div><label>Человек из этого дерева
          <input type="search" value={ownQuery} onChange={(event) => { setOwnQuery(event.target.value); setSource(null); }} placeholder="Поиск среди опубликованных" />
        </label>
          <div className="match-options" aria-label="Свои опубликованные люди">
            {ownPeople.map((person) => <button type="button" key={person.id}
              className={source?.id === person.id ? "is-selected" : ""}
              aria-pressed={source?.id === person.id}
              onClick={() => setSource(person)}>{person.name}<small>{person.birthYear || "?"}–{person.deathYear || "?"}</small></button>)}
            {!ownPeople.length && <p>Опубликуйте свою карточку в разделе «Можно найти».</p>}
          </div>
        </div>
        <div><label>Карточка из другого дерева
          <input type="search" value={targetQuery} onChange={(event) => { setTargetQuery(event.target.value); setTarget(null); setTargets([]); }} placeholder="Введите ФИО (от 2 символов)" />
        </label>
          <div className="match-options" aria-label="Найденные люди в других деревьях">
            {targets.filter((person) => person.archiveId !== archiveId).map((person) => <button type="button"
              key={`${person.archiveId}:${person.id}`} className={target?.archiveId === person.archiveId && target.id === person.id ? "is-selected" : ""}
              aria-pressed={target?.archiveId === person.archiveId && target.id === person.id}
              onClick={() => setTarget(person)}>{person.name}<small>{person.birthYear || "?"}–{person.deathYear || "?"}</small></button>)}
            {targetQuery.trim().length >= 2 && !targets.some((person) => person.archiveId !== archiveId) && <p>Карточек в других деревьях не найдено.</p>}
          </div>
        </div>
      </div>
      {source && target && <div className="match-review">
        <h2>Проверьте обе карточки</h2>
        <div className="match-pair"><CandidateCard candidate={source} /><CandidateCard candidate={target} /></div>
        <button type="button" className="primary-action" disabled={busy} onClick={() => void send()}>Предложить сопоставление</button>
      </div>}
    </section>
    <section className="admin-card archive-form">
      <h2>Запросы между деревьями</h2>
      {!matches.length && <p>Пока нет запросов на сопоставление.</p>}
      {matches.map((item) => <article key={item.id} className="match-request">
        <div className="match-request-heading"><strong>{statusLabel[item.status]}</strong><time dateTime={item.requestedAt}>{new Date(item.requestedAt).toLocaleDateString("ru-RU")}</time></div>
        <div className="match-pair"><CandidateCard candidate={item.left} /><CandidateCard candidate={item.right} /></div>
        <div className="match-request-actions">
          {item.status === "pending" && item.initiatedByArchiveId !== archiveId && <>
            <button type="button" disabled={busy} onClick={() => void decide(item.id, "accept")}>Подтвердить</button>
            <button type="button" disabled={busy} onClick={() => void decide(item.id, "reject")}>Не тот человек</button>
          </>}
          {(item.status === "pending" || item.status === "linked") &&
            <button type="button" disabled={busy} onClick={() => void decide(item.id, "revoke")}>Отозвать связь</button>}
        </div>
      </article>)}
      {(history.length > 0 || nextCursor) && <nav className="match-pages" aria-label="Страницы запросов">
        <button type="button" disabled={!history.length} onClick={() => { setCursor(history.at(-1) || null); setHistory((current) => current.slice(0, -1)); }}>Назад</button>
        <span>Страница {history.length + 1}</span>
        <button type="button" disabled={!nextCursor} onClick={() => { setHistory((current) => [...current,cursor]); setCursor(nextCursor); }}>Далее</button>
      </nav>}
    </section>
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status" className="admin-notice">{notice}</p>}
  </div>;
}
