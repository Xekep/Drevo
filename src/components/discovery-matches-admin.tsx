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
type SuggestedCandidate = Candidate & { reasons: string[]; conflicts: string[] };
type Match = {
  id: string;
  status: "pending" | "linked" | "rejected" | "revoked";
  reason?: string;
  reviewToken?: string;
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
  const [targetCursor, setTargetCursor] = useState<string | null>(null);
  const [targetNextCursor, setTargetNextCursor] = useState<string | null>(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedCandidate[]>([]);
  const [suggestionsBusy, setSuggestionsBusy] = useState(false);
  const [suggestionsTruncated, setSuggestionsTruncated] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [suggestionsReload, setSuggestionsReload] = useState(0);
  const [source, setSource] = useState<Candidate | null>(null);
  const [target, setTarget] = useState<Candidate | null>(null);
  const [reason, setReason] = useState("");
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
    if (!archiveId || targetQuery.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: targetQuery.trim(), excludeArchiveId: archiveId });
      if (targetCursor) params.set("cursor", targetCursor);
      archiveFetch(`/api/discovery/people?${params}`, {
        signal: controller.signal, cache: "no-store",
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Не удалось найти карточки");
        setTargets((current) => targetCursor ? [...current, ...body.results] : body.results);
        setTargetNextCursor(body.nextCursor);
      }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); })
        .finally(() => { if (!controller.signal.aborted) setTargetLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [targetQuery, archiveId, targetCursor]);

  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    archiveFetch(`${endpoint}/candidates?sourcePersonId=${encodeURIComponent(source.id)}${showIgnored ? "&ignored=1" : ""}`, {
      signal: controller.signal, cache: "no-store",
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось найти возможные совпадения");
      setSuggestions(body.candidates);
      setSuggestionsTruncated(body.truncated);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setSuggestionsBusy(false); });
    return () => controller.abort();
  }, [source, reload, showIgnored, suggestionsReload]);

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
        body: JSON.stringify({ sourcePersonId: source.id, targetArchiveId: target.archiveId,
          targetPersonId: target.id, reason: reason.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось отправить запрос");
      setNotice(body.match.status === "pending" ? "Запрос отправлен. Другая сторона должна подтвердить сопоставление." :
        "Этот запрос уже существует. Его текущий статус показан ниже.");
      setSource(null); setTarget(null); setCursor(null); setHistory([]);
      setReason("");
      setSuggestions([]); setSuggestionsBusy(false); setSuggestionsTruncated(false);
      setShowIgnored(false);
      setReload((value) => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function decide(id: string, decision: "accept" | "reject" | "revoke", reviewToken?: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await archiveFetch(`${endpoint}/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(decision === "accept" ? { reviewToken } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (decision === "accept" && response.status === 409) setReload((value) => value + 1);
        throw new Error(body.error || "Не удалось изменить решение");
      }
      setNotice(decision === "accept" ? "Сопоставление подтверждено." :
        decision === "reject" ? "Запрос отклонён." : "Связь отозвана.");
      setReload((value) => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function setIgnored(person: Candidate, ignored: boolean) {
    if (!source) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await archiveFetch(`${endpoint}/ignored`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePersonId: source.id, targetArchiveId: person.archiveId,
          targetPersonId: person.id, ignored }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось изменить подсказку");
      setSuggestions((current) => current.filter((item) =>
        item.archiveId !== person.archiveId || item.id !== person.id));
      if (target?.archiveId === person.archiveId && target.id === person.id) setTarget(null);
      setNotice(ignored ? "Подсказка скрыта. Её можно вернуть в списке скрытых." : "Подсказка восстановлена.");
      setSuggestionsReload((value) => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="discovery-matches-admin">
    <section className="admin-card archive-form">
      <p>Сопоставление подтверждает, что две опубликованные карточки описывают одного человека. После подтверждения переход между ними доступен вошедшим пользователям. Оно не объединяет деревья и не открывает чужую ветку.</p>
      <div className="match-search-grid">
        <div><label>Человек из этого дерева
          <input type="search" value={ownQuery} onChange={(event) => {
            setOwnQuery(event.target.value); setSource(null); setSuggestions([]);
            setSuggestionsBusy(false); setSuggestionsTruncated(false); setShowIgnored(false);
          }} placeholder="Поиск среди опубликованных" />
        </label>
          <div className="match-options" aria-label="Свои опубликованные люди">
            {ownPeople.map((person) => <button type="button" key={person.id}
              className={source?.id === person.id ? "is-selected" : ""}
              aria-pressed={source?.id === person.id}
              onClick={() => {
                setSource(person); setTarget(null); setSuggestions([]);
                setSuggestionsBusy(true); setSuggestionsTruncated(false); setShowIgnored(false);
              }}>{person.name}<small>{person.birthYear || "?"}–{person.deathYear || "?"}</small></button>)}
            {!ownPeople.length && <p>Опубликуйте свою карточку в разделе «Можно найти».</p>}
          </div>
        </div>
        <div><label>Карточка из другого дерева
          <input type="search" value={targetQuery} onChange={(event) => {
            setTargetQuery(event.target.value); setTarget(null); setTargets([]);
            setTargetCursor(null); setTargetNextCursor(null);
            setTargetLoading(event.target.value.trim().length >= 2);
          }} placeholder="Введите ФИО (от 2 символов)" />
        </label>
          <div className="match-options" aria-label="Найденные люди в других деревьях">
            {targets.filter((person) => person.archiveId !== archiveId).map((person) => <button type="button"
              key={`${person.archiveId}:${person.id}`} className={target?.archiveId === person.archiveId && target.id === person.id ? "is-selected" : ""}
              aria-pressed={target?.archiveId === person.archiveId && target.id === person.id}
              onClick={() => setTarget(person)}>{person.name}<small>{person.birthYear || "?"}–{person.deathYear || "?"}</small></button>)}
            {targetLoading && <p role="status">Ищем…</p>}
            {targetQuery.trim().length >= 2 && !targetLoading && !targets.some((person) => person.archiveId !== archiveId) && <p>Карточек в других деревьях не найдено.</p>}
          </div>
          {targetNextCursor && <button type="button" className="match-more" disabled={targetLoading}
            onClick={() => { setTargetLoading(true); setTargetCursor(targetNextCursor); }}>Показать ещё</button>}
        </div>
      </div>
      {source && <div className="match-suggestions">
        <div className="match-suggestions-heading">
          <h2>{showIgnored ? "Скрытые подсказки" : "Возможные совпадения"}</h2>
          <button type="button" onClick={() => {
            setShowIgnored((value) => !value); setSuggestions([]); setSuggestionsBusy(true);
          }}>{showIgnored ? "К предложениям" : "Скрытые"}</button>
        </div>
        <p>Подсказки основаны только на опубликованных именах, годах и местах. Проверьте сведения перед отправкой запроса.</p>
        {suggestionsBusy && <p role="status">Ищем совпадения…</p>}
        {!suggestionsBusy && !suggestions.length && <p>{showIgnored ? "Скрытых подсказок нет." : "Пока совпадений нет. Можно найти карточку вручную."}</p>}
        <div className="match-suggestion-list">
          {suggestions.map((item) => <div className="match-suggestion" key={`${item.archiveId}:${item.id}`}>
            {showIgnored ? <div className="match-suggestion-summary">
              <strong>{item.name}</strong><small>{item.reasons.join(" · ")}</small>
            </div> : <button type="button"
              className={target?.archiveId === item.archiveId && target.id === item.id ? "is-selected" : ""}
              aria-pressed={target?.archiveId === item.archiveId && target.id === item.id}
              onClick={() => setTarget(item)}>
              <strong>{item.name}</strong>
              <small>{item.reasons.join(" · ")}</small>
              {item.conflicts.length > 0 && <small className="match-conflicts">Расхождения: {item.conflicts.join("; ")}</small>}
            </button>}
            <button type="button" className="match-ignore-action" disabled={busy}
              onClick={() => void setIgnored(item, !showIgnored)}>{showIgnored ? "Вернуть" : "Не тот"}</button>
          </div>)}
        </div>
        {suggestionsTruncated && <p>Показана часть похожих карточек. Для точного поиска введите ФИО справа.</p>}
      </div>}
      {source && target && <div className="match-review">
        <h2>Проверьте обе карточки</h2>
        <div className="match-pair"><CandidateCard candidate={source} /><CandidateCard candidate={target} /></div>
        <label>Почему это один человек? <small>Необязательно; сообщение увидит другое дерево</small>
          <textarea value={reason} maxLength={500} rows={2} onChange={(event) => setReason(event.target.value)}
            placeholder="Например: совпадают родители и место рождения" />
        </label>
        <button type="button" className="primary-action" disabled={busy} onClick={() => void send()}>Предложить сопоставление</button>
      </div>}
    </section>
    <section className="admin-card archive-form">
      <h2>Запросы между деревьями</h2>
      {!matches.length && <p>Пока нет запросов на сопоставление.</p>}
      {matches.map((item) => <article key={item.id} className="match-request">
        <div className="match-request-heading"><strong>{statusLabel[item.status]}</strong><time dateTime={item.requestedAt}>{new Date(item.requestedAt).toLocaleDateString("ru-RU")}</time></div>
        <div className="match-pair"><CandidateCard candidate={item.left} /><CandidateCard candidate={item.right} /></div>
        {item.reason && <p className="match-reason">Основание: {item.reason}</p>}
        <div className="match-request-actions">
          {item.status === "pending" && item.initiatedByArchiveId !== archiveId && <>
            <button type="button" disabled={busy || !item.reviewToken}
              data-review-token={item.reviewToken}
              onClick={() => void decide(item.id, "accept", item.reviewToken)}>Подтвердить</button>
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
