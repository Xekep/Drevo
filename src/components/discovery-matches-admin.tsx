import { useEffect, useRef, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { DiscoveryLinkedCardShare } from "./discovery-linked-card-share.tsx";
import { DiscoveryBranchShare } from "./discovery-branch-share.tsx";
import { adminMatchSourceAt, adminMatchTargetAt } from "../domain/archive-routes.ts";
import { archiveTargetPath } from "../domain/archive-links.ts";
import { scopedArchivePath } from "../domain/archive-context.ts";
import type { Family } from "../domain/types.ts";
import { PublishPersonDialog } from "./publish-person-dialog.tsx";
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
type IgnoredArchive = { archiveId: string; exampleName?: string };
type Match = {
  id: string;
  status: "pending" | "linked" | "rejected" | "revoked";
  reason?: string;
  decisionNote?: string;
  reviewToken?: string;
  changedSinceRequest?: boolean;
  confirmationHistoryAvailable?: boolean;
  changedSinceConfirmation?: boolean;
  changedFieldsSinceConfirmation?: { side: "left" | "right"; field: keyof Candidate }[];
  confirmation?: {
    confirmedAt: string;
    requestedBy: string;
    confirmedBy: string;
    leftPublicationVersion: string;
    rightPublicationVersion: string;
    left: Partial<Candidate>;
    right: Partial<Candidate>;
  };
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

function CandidateCard({ candidate, ownArchiveId }: { candidate: Candidate; ownArchiveId: string }) {
  const origin = candidate.archiveId === ownArchiveId
    ? "Ваш архив" : `Исходный архив: ${candidate.archiveId}`;
  return <div className="match-candidate-card">
    <small className="match-candidate-origin" title={origin}>{origin}</small>
    {candidate.name ? <a href={`/discover/person/${encodeURIComponent(candidate.archiveId)}/${encodeURIComponent(candidate.id)}`}>
      <strong>{candidate.name}</strong>
    </a> : <strong>Карточка больше не опубликована</strong>}
    {candidate.birthSurname && <small>При рождении: {candidate.birthSurname}</small>}
    {(candidate.birthYear || candidate.deathYear) && <small>{candidate.birthYear || "?"}–{candidate.deathYear || "?"}</small>}
    {candidate.birthPlace && <small>Рождение: {candidate.birthPlace}</small>}
    {candidate.deathPlace && <small>Смерть: {candidate.deathPlace}</small>}
  </div>;
}

const comparedFields = [
  ["name", "Имя"], ["birthSurname", "Фамилия при рождении"],
  ["birthYear", "Год рождения"], ["deathYear", "Год смерти"],
  ["birthPlace", "Место рождения"], ["deathPlace", "Место смерти"],
] as const;

function PublishedPairComparison({ own, other }: { own: Candidate; other: Candidate }) {
  // A withdrawn card has no published name. Never compare it with a cached peer.
  if (!own.name || !other.name) return null;
  return <section className="match-pair-comparison" aria-label="Сравнение опубликованных полей">
    <h3>Сравнение опубликованных полей</h3>
    <p>Совпадение текста не доказывает, что это один человек. Отсутствующее значение
      может быть не заполнено или не разрешено к публикации.</p>
    <dl>{comparedFields.filter(([field]) => own[field] || other[field]).map(([field, label]) => {
      const ownValue = own[field];
      const otherValue = other[field];
      const state = !ownValue || !otherValue ? "Недостаточно опубликованных сведений"
        : ownValue.trim().toLocaleLowerCase("ru-RU") === otherValue.trim().toLocaleLowerCase("ru-RU")
          ? "Текст совпадает" : "Текст различается";
      return <div key={field}>
        <dt>{label} <small>{state}</small></dt>
        <dd><span>Ваше дерево: {ownValue || "Нет в публикации"}</span>
          <span>Другое дерево: {otherValue || "Нет в публикации"}</span></dd>
      </div>;
    })}</dl>
  </section>;
}

export function DiscoveryMatchesAdmin({ family }: { family: Family }) {
  const [linkedTarget] = useState(() => typeof window === "undefined"
    ? null : adminMatchTargetAt(window.location.pathname));
  const [linkedSource] = useState(() => typeof window === "undefined"
    ? null : adminMatchSourceAt(window.location.pathname));
  const [sourceUnavailable, setSourceUnavailable] = useState(false);
  const [showPublication, setShowPublication] = useState(false);
  const [, setPublicationPublished] = useState(false);
  const [sourceReload, setSourceReload] = useState(0);
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
  const [suggestionsCursor, setSuggestionsCursor] = useState<string | null>(null);
  const [suggestionsNextCursor, setSuggestionsNextCursor] = useState<string | null>(null);
  const [suggestionsStale, setSuggestionsStale] = useState(false);
  const [suggestionsRefine, setSuggestionsRefine] = useState(false);
  const [suggestionsApproximate, setSuggestionsApproximate] = useState(false);
  const [suggestionsPartial, setSuggestionsPartial] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [suggestionsReload, setSuggestionsReload] = useState(0);
  const [ignoredArchives, setIgnoredArchives] = useState<IgnoredArchive[]>([]);
  const [ignoredArchivePage, setIgnoredArchivePage] = useState(0);
  const [nextIgnoredArchivePage, setNextIgnoredArchivePage] = useState<number | null>(null);
  const [ignoredArchiveReload, setIgnoredArchiveReload] = useState(0);
  const [source, setSource] = useState<Candidate | null>(null);
  const [target, setTarget] = useState<Candidate | null>(null);
  const [reason, setReason] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [matchesLoading, setMatchesLoading] = useState(true);
  const [matchesReload, setMatchesReload] = useState(0);
  const matchesRequest = useRef<AbortController | null>(null);
  const matchesGeneration = useRef(0);
  const [deferredMatches, setDeferredMatches] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!linkedSource) return;
    const controller = new AbortController();
    archiveFetch(`${endpoint}/own-people?personId=${encodeURIComponent(linkedSource)}`,
      { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          const error = new Error(body.error || "Карточка не опубликована") as Error & { status: number };
          error.status = response.status;
          throw error;
        }
        const person = body.people?.[0] as Candidate | undefined;
        if (!person || person.id !== linkedSource || person.archiveId !== body.archiveId)
          throw new Error("Карточка не опубликована");
        if (!controller.signal.aborted) {
          setArchiveId(body.archiveId);
          setSource(person);
          setSourceUnavailable(false);
          setError("");
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setSource(null);
          setSourceUnavailable((reason as { status?: number }).status === 404);
          setError((reason as Error).message);
        }
      });
    return () => controller.abort();
  }, [linkedSource, sourceReload]);

  useEffect(() => {
    if (!linkedTarget) return;
    const controller = new AbortController();
    archiveFetch(`/api/discovery/people/${encodeURIComponent(linkedTarget.archiveId)}/${encodeURIComponent(linkedTarget.personId)}`,
      { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Опубликованная карточка недоступна");
        const person = body.person as Candidate | undefined;
        if (!person || person.archiveId !== linkedTarget.archiveId || person.id !== linkedTarget.personId)
          throw new Error("Опубликованная карточка недоступна");
        if (!controller.signal.aborted) setTarget(person);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setTarget(null);
          setError((reason as Error).message);
        }
      });
    return () => controller.abort();
  }, [linkedTarget]);

  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      // A publication or link may have been revoked in another tab while this list was open.
      matchesGeneration.current++;
      matchesRequest.current?.abort();
      setMatches([]);
      setMatchesLoading(true);
      setMatchesReload((value) => value + 1);
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) recheck(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

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
    if (!source || suggestionsStale) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ sourcePersonId: source.id });
    if (showIgnored) params.set("ignored", "1");
    if (suggestionsCursor) params.set("cursor", suggestionsCursor);
    archiveFetch(`${endpoint}/candidates?${params}`, {
      signal: controller.signal, cache: "no-store",
    }).then(async (response) => {
      const body = await response.json();
      if (response.status === 409 && !controller.signal.aborted) {
        setSuggestions([]);
        setSuggestionsCursor(null);
        setSuggestionsNextCursor(null);
        setSuggestionsStale(true);
        setSuggestionsBusy(false);
        setTarget(null);
      }
      if (response.status === 422 && body.refineRequired) {
        setSuggestions([]);
        setSuggestionsNextCursor(null);
        setSuggestionsRefine(true);
        setSuggestionsApproximate(false);
        setSuggestionsPartial(false);
        return;
      }
      if (!response.ok) throw new Error(body.error || "Не удалось найти возможные совпадения");
      setSuggestionsStale(false);
      setSuggestionsRefine(false);
      setSuggestionsApproximate((current) => suggestionsCursor ? current || body.approximate === true
        : body.approximate === true);
      setSuggestionsPartial(body.partial === true);
      setSuggestions((current) => suggestionsCursor
        ? [...current, ...body.candidates.filter((item: SuggestedCandidate) =>
          !current.some((old) => old.archiveId === item.archiveId && old.id === item.id))]
        : body.candidates);
      setSuggestionsNextCursor(body.nextCursor || null);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setSuggestionsBusy(false); });
    return () => controller.abort();
  }, [source, reload, showIgnored, suggestionsCursor, suggestionsReload, suggestionsStale]);

  useEffect(() => {
    const controller = new AbortController();
    archiveFetch(`${endpoint}/ignored-archives?page=${ignoredArchivePage}`, {
      signal: controller.signal, cache: "no-store",
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось загрузить скрытые деревья");
      setIgnoredArchives((current) => ignoredArchivePage
        ? [...current, ...body.archives.filter((item: IgnoredArchive) =>
          !current.some((old) => old.archiveId === item.archiveId))]
        : body.archives);
      setNextIgnoredArchivePage(body.nextPage);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [ignoredArchivePage, ignoredArchiveReload]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = matchesGeneration.current;
    matchesRequest.current = controller;
    archiveFetch(`${endpoint}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
      signal: controller.signal, cache: "no-store",
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось загрузить сопоставления");
      if (controller.signal.aborted || generation !== matchesGeneration.current) return;
      setArchiveId(body.archiveId);
      setMatches(body.matches);
      setNextCursor(body.nextCursor);
    }).catch((reason) => {
      if (!controller.signal.aborted && generation === matchesGeneration.current) setError(reason.message);
    }).finally(() => {
      if (!controller.signal.aborted && generation === matchesGeneration.current) setMatchesLoading(false);
    });
    return () => {
      controller.abort();
      if (matchesRequest.current === controller) matchesRequest.current = null;
    };
  }, [cursor, reload, matchesReload]);

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
      setSuggestions([]); setSuggestionsBusy(false); setSuggestionsCursor(null); setSuggestionsNextCursor(null);
      setShowIgnored(false);
      setReload((value) => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function decide(id: string, decision: "accept" | "reject" | "revoke", reviewToken?: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const note = decision === "revoke" ? "" : decisionNotes[id]?.trim();
      const response = await archiveFetch(`${endpoint}/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(decision === "accept" ? { reviewToken } : {}),
          ...(note ? { note } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (decision === "accept" && response.status === 409) setReload((value) => value + 1);
        throw new Error(body.error || "Не удалось изменить решение");
      }
      setNotice(decision === "accept" ? "Сопоставление подтверждено." :
        decision === "reject" ? "Запрос отклонён. Эта подсказка скрыта для вашего дерева; вернуть её можно в списке «Скрытые»." : "Связь отозвана.");
      if (decision === "reject") {
        setSuggestions([]); setSuggestionsCursor(null); setSuggestionsNextCursor(null);
        setSuggestionsReload((value) => value + 1);
      }
      setDecisionNotes((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
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
      setSuggestionsCursor(null); setSuggestionsNextCursor(null);
      setSuggestionsReload((value) => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function setIgnoredArchive(targetArchiveId: string, ignored: boolean) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await archiveFetch(`${endpoint}/ignored-archives`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetArchiveId, ignored }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось изменить скрытое дерево");
      if (target?.archiveId === targetArchiveId) setTarget(null);
      setNotice(ignored ? "Подсказки этого дерева скрыты. Ручной поиск остаётся доступным."
        : "Подсказки этого дерева снова доступны.");
      setIgnoredArchivePage(0);
      setIgnoredArchiveReload((value) => value + 1);
      setSuggestionsCursor(null); setSuggestionsNextCursor(null);
      setSuggestionsReload((value) => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  const visibleMatches = matches.filter((item) => item.status !== "pending" ||
    !deferredMatches.has(`${archiveId}:${item.id}`));
  const deferredCount = matches.length - visibleMatches.length;
  const linkedSourcePerson = linkedSource
    ? family.people.find((person) => person.id === linkedSource) : undefined;

  return <div className="discovery-matches-admin">
    <section className="admin-card archive-form">
      <p>Сопоставление подтверждает, что две опубликованные карточки описывают одного человека. После подтверждения переход между ними доступен вошедшим пользователям. Оно не объединяет деревья и не открывает чужую ветку.</p>
      <div className="match-search-grid">
        <div><label>Человек из этого дерева
          <input type="search" value={ownQuery} onChange={(event) => {
            setOwnQuery(event.target.value); setSource(null); setSourceUnavailable(false); setSuggestions([]);
            setSuggestionsBusy(false); setSuggestionsCursor(null); setSuggestionsNextCursor(null);
            setSuggestionsStale(false); setSuggestionsRefine(false);
            setSuggestionsApproximate(false); setSuggestionsPartial(false); setShowIgnored(false);
          }} placeholder="Поиск среди опубликованных" />
        </label>
          <div className="match-options" aria-label="Свои опубликованные люди">
            {ownPeople.map((person) => <button type="button" key={person.id}
              className={source?.id === person.id ? "is-selected" : ""}
              aria-pressed={source?.id === person.id}
              onClick={() => {
                setSource(person);
                setSourceUnavailable(false);
                setTarget((current) => linkedTarget && current?.archiveId === linkedTarget.archiveId &&
                  current.id === linkedTarget.personId ? current : null);
                setSuggestions([]);
                setSuggestionsBusy(true); setSuggestionsCursor(null); setSuggestionsNextCursor(null);
                setSuggestionsStale(false); setSuggestionsRefine(false);
                setSuggestionsApproximate(false); setSuggestionsPartial(false); setShowIgnored(false);
                setSuggestionsReload((value) => value + 1);
              }}>{person.name}<small>{person.birthYear || "?"}–{person.deathYear || "?"}</small></button>)}
            {!ownPeople.length && !source && <p>Опубликуйте свою карточку в разделе «Можно найти».</p>}
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
      {linkedSource && source?.id === linkedSource && <div className="match-review">
        <h2>Карточка из вашего дерева</h2>
        <CandidateCard candidate={source} ownArchiveId={archiveId} />
        <p>Выберите предложенное совпадение или найдите опубликованную карточку другого дерева вручную.</p>
      </div>}
      {linkedSource && sourceUnavailable && (linkedSourcePerson
        ? <p role="status">Сначала опубликуйте эту карточку в разделе «Можно найти». После публикации вернитесь к сопоставлению.
          <button type="button" onClick={() => setShowPublication(true)}>Открыть публикацию карточки</button>
          <a href={scopedArchivePath(archiveTargetPath({ kind: "person", id: linkedSource }))}>Вернуться к человеку</a>
        </p>
        : <p role="status">Карточка недоступна в этом дереве.</p>)}
      {showPublication && linkedSourcePerson &&
        <PublishPersonDialog person={linkedSourcePerson}
          onStatus={setPublicationPublished} onClose={() => {
            setShowPublication(false);
            setSourceUnavailable(false);
            setSourceReload((value) => value + 1);
          }} />}
      {linkedTarget && target && !source && <div className="match-review">
        <h2>Карточка из ссылки</h2>
        <CandidateCard candidate={target} ownArchiveId={archiveId} />
        <p>Выберите опубликованную карточку из своего дерева, чтобы сравнить сведения и предложить связь.</p>
      </div>}
      {source && <div className="match-suggestions">
        <div className="match-suggestions-heading">
          <h2>{showIgnored ? "Скрытые подсказки" : "Возможные совпадения"}</h2>
          <button type="button" onClick={() => {
            setShowIgnored((value) => !value); setSuggestions([]); setSuggestionsBusy(true);
            setSuggestionsCursor(null); setSuggestionsNextCursor(null); setSuggestionsStale(false);
          }}>{showIgnored ? "К предложениям" : "Скрытые"}</button>
        </div>
        <p>Подсказки основаны только на опубликованных именах, годах и местах. Проверьте сведения перед отправкой запроса.</p>
        {suggestionsStale && <p role="status">Публикации изменились. Обновите подсказки перед продолжением.
          <button type="button" onClick={() => {
            setSuggestionsStale(false); setError(""); setSuggestionsBusy(true);
            setSuggestionsReload((value) => value + 1);
          }}>Обновить подсказки</button>
        </p>}
        {suggestionsBusy && <p role="status">Ищем совпадения…</p>}
        {suggestionsRefine && <p role="status">Для поиска по родству оставьте не более 32 разных и 128 общих подсказок о близких родственниках в настройках публикации карточки.
          <a href={scopedArchivePath(archiveTargetPath({ kind: "person", id: source.id }))}>Открыть карточку</a>
          <button type="button" onClick={() => { setSuggestionsCursor(null); setSuggestionsBusy(true);
            setSuggestionsReload((value) => value + 1); }}>Повторить поиск</button>
        </p>}
        {suggestionsApproximate && <p role="status">Приближённые совпадения проверяются ограниченной порцией опубликованных карточек. Порядок внутри неё не означает вероятность совпадения.{suggestionsPartial ? " Можно продолжить поиск на следующей странице." : ""}</p>}
        {!suggestionsRefine && !suggestionsStale && !suggestionsBusy && !suggestions.length && !suggestionsNextCursor && <p>{showIgnored ? "Скрытых подсказок нет." : "Пока совпадений нет. Можно найти карточку вручную."}</p>}
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
            <div className="match-suggestion-actions">
              <button type="button" className="match-ignore-action" disabled={busy}
                onClick={() => void setIgnored(item, !showIgnored)}>{showIgnored ? "Вернуть" : "Не тот"}</button>
              {!showIgnored && <button type="button" className="match-ignore-action" disabled={busy}
                onClick={() => void setIgnoredArchive(item.archiveId, true)}>Скрыть дерево</button>}
            </div>
          </div>)}
        </div>
        {suggestionsNextCursor && <button type="button" className="match-more" disabled={suggestionsBusy}
          onClick={() => { setSuggestionsBusy(true); setSuggestionsCursor(suggestionsNextCursor); setSuggestionsReload((value) => value + 1); }}>
          {suggestionsBusy ? "Ищем…" : "Показать ещё похожих"}
        </button>}
      </div>}
      <details className="match-ignored-archives">
        <summary>Скрытые деревья{ignoredArchives.length ? ` · ${ignoredArchives.length}${nextIgnoredArchivePage !== null ? "+" : ""}` : ""}</summary>
        {!ignoredArchives.length && <p>Нет скрытых деревьев.</p>}
        {ignoredArchives.map((item) => <div className="match-ignored-archive" key={item.archiveId}>
          <span>{item.exampleName ? `Дерево с карточкой «${item.exampleName}»` : "Дерево без опубликованных карточек"}</span>
          <button type="button" disabled={busy} onClick={() => void setIgnoredArchive(item.archiveId, false)}>Вернуть дерево</button>
        </div>)}
        {nextIgnoredArchivePage !== null && <button type="button" disabled={busy}
          onClick={() => setIgnoredArchivePage(nextIgnoredArchivePage)}>Показать ещё</button>}
      </details>
      {source && target && <div className="match-review">
        <h2>Проверьте обе карточки</h2>
        <div className="match-pair"><CandidateCard candidate={source} ownArchiveId={archiveId} />
          <CandidateCard candidate={target} ownArchiveId={archiveId} /></div>
        <PublishedPairComparison own={source} other={target} />
        <label>Почему это один человек? <small>Необязательно; сообщение увидит другое дерево</small>
          <textarea value={reason} maxLength={500} rows={2} onChange={(event) => setReason(event.target.value)}
            placeholder="Например: совпадают родители и место рождения" />
        </label>
        <button type="button" className="primary-action" disabled={busy} onClick={() => void send()}>Предложить сопоставление</button>
      </div>}
    </section>
    <section className="admin-card archive-form">
      <h2>Запросы между деревьями</h2>
      {deferredCount > 0 && <p>Отложено до следующего открытия раздела: {deferredCount}. <button type="button"
        onClick={() => { setDeferredMatches(new Set()); setNotice("Отложенные запросы снова показаны."); }}>Показать сейчас</button></p>}
      {matchesLoading && <p role="status">Проверяем доступность связей…</p>}
      {!matchesLoading && !visibleMatches.length && <p>{deferredCount ? "Сейчас нет запросов для рассмотрения." : "Пока нет запросов на сопоставление."}</p>}
      {visibleMatches.map((item) => <article key={item.id} className="match-request">
        <div className="match-request-heading"><strong>{statusLabel[item.status]}</strong><time dateTime={item.requestedAt}>{new Date(item.requestedAt).toLocaleDateString("ru-RU")}</time></div>
        <div className="match-pair"><CandidateCard candidate={item.left} ownArchiveId={archiveId} />
          <CandidateCard candidate={item.right} ownArchiveId={archiveId} /></div>
        <PublishedPairComparison
          own={item.left.archiveId === archiveId ? item.left : item.right}
          other={item.left.archiveId === archiveId ? item.right : item.left} />
        {item.reason && <p className="match-reason">Основание: {item.reason}</p>}
        {item.decisionNote && <p className="match-reason">Пояснение решения: {item.decisionNote}</p>}
        {item.status === "pending" && item.changedSinceRequest &&
          <p className="match-reason">Опубликованные сведения изменились после запроса. Сверьте обе карточки перед решением.</p>}
        {item.status === "linked" && item.confirmationHistoryAvailable === false &&
          <p className="match-reason">История сведений на момент подтверждения для этой связи недоступна.</p>}
        {item.status === "linked" && item.changedSinceConfirmation &&
          <p className="match-reason" role="status">Опубликованные сведения изменились после подтверждения связи: {item.changedFieldsSinceConfirmation?.map(({ side, field }) =>
            `${side === "left" ? "первая" : "вторая"} карточка — ${comparedFields.find(([key]) => key === field)?.[1] || field}`).join(", ")}.
            Связь и выданные разрешения сохраняются; сверьте текущие карточки.</p>}
        {item.status === "linked" && item.confirmation && <details>
          <summary>Сведения на момент подтверждения</summary>
          <p>Дата подтверждения: <time dateTime={item.confirmation.confirmedAt}>
            {new Date(item.confirmation.confirmedAt).toLocaleString("ru-RU")}</time>.</p>
          <div className="match-pair">{(["left", "right"] as const).map((side) =>
            <section key={side} className="match-candidate-card">
              <strong>{side === "left" ? "Первая карточка" : "Вторая карточка"}</strong>
              <dl>{comparedFields.filter(([field]) => item.confirmation?.[side][field] != null).map(([field, label]) =>
                <div key={field}><dt>{label}</dt><dd>{item.confirmation?.[side][field]}</dd></div>)}</dl>
            </section>)}</div>
        </details>}
        <div className="match-request-actions">
          {item.status === "pending" && item.initiatedByArchiveId !== archiveId && <>
            <details className="match-decision-note">
              <summary>Добавить пояснение</summary>
              <label>Пояснение к решению (необязательно)
                <textarea value={decisionNotes[item.id] || ""} maxLength={500} rows={2}
                  onChange={(event) => setDecisionNotes((current) => ({
                    ...current, [item.id]: event.target.value,
                  }))} />
              </label>
              <small>Его увидят владельцы обоих деревьев. После повторной публикации любой карточки пояснение скрывается. Не добавляйте закрытые сведения.</small>
            </details>
            <button type="button" disabled={busy || !item.reviewToken}
              data-review-token={item.reviewToken}
              onClick={() => void decide(item.id, "accept", item.reviewToken)}>Подтвердить</button>
            <button type="button" disabled={busy} onClick={() => void decide(item.id, "reject")}>Не тот человек</button>
            <button type="button" disabled={busy} onClick={() => {
              setDeferredMatches((current) => new Set(current).add(`${archiveId}:${item.id}`));
              setError("");
              setNotice("Запрос отложен до следующего открытия раздела. Ответ другой стороне не отправлен.");
            }}>Позже</button>
          </>}
          {(item.status === "pending" || item.status === "linked") &&
            <button type="button" disabled={busy} onClick={() => void decide(item.id, "revoke")}>Отозвать связь</button>}
        </div>
        {item.status === "linked" && <><DiscoveryLinkedCardShare matchId={item.id} />
          <DiscoveryBranchShare matchId={item.id} archiveId={archiveId} /></>}
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
