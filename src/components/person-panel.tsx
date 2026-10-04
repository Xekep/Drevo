import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveResourceUrl, scopedArchivePath } from "../domain/archive-context.ts";
import { archiveDocumentPath } from "../domain/archive-routes.ts";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  ArrowDownUp,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  FileText,
  Sprout,
} from "lucide-react";
import {
  ageLabel,
  analyzeKinship,
  dateLabel,
  dateYear,
  edgeLabel,
  ERAS,
  resolvedSex,
  safeUrl,
  years,
  hasRecordedDeath,
  type Person,
  type Family,
  type FamilyLink,
  type PersonValueClaim,
  CLAIM_CONFIDENCE_LABELS,
  CONNECTION_NAMES,
} from "../domain";
import { collectPersonSources, repositorySummary } from "../domain/person-sources.ts";
import { PortraitPlaceholder } from "./portrait-placeholder";
import { PersonAwards } from "./person-awards";
import { PersonEvents } from "./person-events";
import { MemorialName } from "./memorial-name";
import { mediaPreview } from "../domain/media-preview";
import { useDiscussionCount } from "./discussion/use-discussion-count";
const PersonDiscussion = lazy(() => import("./person-discussion").then((module) => ({ default: module.PersonDiscussion })));
const claimSummary = (claim: PersonValueClaim) =>
  `${claim.sources.map((source) => source.title).join("; ")}${claim.confidence
    ? ` · Оценка: ${CLAIM_CONFIDENCE_LABELS[claim.confidence]}` : ""}`;
function alternativeFacts(person: Person, kind: "birth" | "death" | "maidenName" | "occupation") {
  const label = {
    birth: "Другая дата рождения", death: "Другая дата смерти",
    birthPlace: "Другое место рождения", deathPlace: "Другое место смерти",
    maidenName: "Другая фамилия при рождении", occupation: "Другое занятие",
  } as const;
  return (person.factAlternatives || []).filter((alternative) =>
    alternative.field === kind || ((kind === "birth" || kind === "death") &&
      alternative.field === `${kind}Place`)).map((alternative) =>
      <p key={alternative.id} className="life-fact-alternative">
        {label[alternative.field]}: {["birth", "death"].includes(alternative.field)
          ? dateLabel(alternative.value) : alternative.value}
        {" · "}{claimSummary(alternative)}
      </p>);
}
export function Avatar({
  person,
  large = false,
  loading = "lazy",
  preview = "thumb",
}: {
  person: Person;
  large?: boolean;
  loading?: "eager" | "lazy";
  preview?: "avatar" | "thumb";
}) {
  const [failed, setFailed] = useState<string>();
  const src = mediaPreview(safeUrl(person.photo), preview);
  return (
    <span
      className={`${large ? "profile-avatar" : "person-avatar"} ${resolvedSex(person) === "u" ? "unknown" : resolvedSex(person) === "f" ? "female" : "male"}`}
    >
      {/* Native image keeps optional archive photos independent of an image service. */}
      {src && failed !== src ? (
        <img src={src} alt="" loading={loading} onError={() => setFailed(src)} />
      ) : (
        <PortraitPlaceholder />
      )}
    </span>
  );
}

function LifeSpan({ person }: { person: Person }) {
  if (!person.birth || (hasRecordedDeath(person) && !person.death)) return null;
  const birth = dateYear(person.birth),
    death = dateYear(person.death);
  const lived = ERAS.filter((e) => e.start <= death && e.end > birth);
  return (
    <div className="lifespan">
      <div className="section-label">ВРЕМЯ ЖИЗНИ</div>
      <div
        className="lifespan-bar"
        aria-label={`Жизнь с ${birth} по ${person.death ? death : "настоящее время"}`}
      >
        {lived.map((e) => (
          <span
            key={e.name}
            title={`${e.name}: ${Math.max(e.start, birth)}–${Math.min(e.end, death)}`}
            style={{
              background: e.color,
              flex: Math.max(
                1,
                Math.min(e.end, death) - Math.max(e.start, birth),
              ),
            }}
          />
        ))}
      </div>
      <div className="lifespan-dates">
        <span>{birth}</span>
        <span>{person.death ? death : "сегодня"}</span>
      </div>
      <div className="lifespan-legend">
        {lived.map((e) => (
          <span key={e.name}>
            <i style={{ background: e.color }} />
            {e.short}
          </span>
        ))}
      </div>
    </div>
  );
}

export function PersonPanel({
  person,
  people,
  links,
  unions,
  onSelect,
  onCompare,
  suggestions,
  isCurrentUser = false,
  canDiscuss = false,
  canLoadDocuments = false,
  idPrefix = "person",
}: {
  person: Person;
  people: Person[];
  links?: FamilyLink[];
  unions?: Family["unions"];
  onSelect: (id: string) => void;
  onCompare?: () => void;
  suggestions?: ReactNode;
  isCurrentUser?: boolean;
  canDiscuss?: boolean;
  canLoadDocuments?: boolean;
  idPrefix?: string;
}) {
  const [tab, setTab] = useState<"bio" | "sources" | "discussion">("bio");
  const discussionCount = useDiscussionCount(person.id, canDiscuss);
  const [documents, setDocuments] = useState<{
    personId: string;
    retry: number;
    items: Array<{ id: string; title: string }>;
    error: string;
  }>({ personId: "", retry: -1, items: [], error: "" });
  const [documentCount, setDocumentCount] = useState<{
    personId: string;
    retry: number;
    total: number;
  }>({ personId: "", retry: -1, total: 0 });
  const [documentRetry, setDocumentRetry] = useState(0);
  useEffect(() => {
    if (!canLoadDocuments) return;
    const request = new AbortController();
    void (async () => {
      try {
        const response = await archiveFetch(
          `/api/documents?personId=${encodeURIComponent(person.id)}&limit=1`,
          { signal: request.signal },
        );
        if (!response.ok) return;
        const page = (await response.json()) as { total: number };
        if (!request.signal.aborted)
          setDocumentCount({
            personId: person.id,
            retry: documentRetry,
            total: page.total,
          });
      } catch {
        // The sources tab shows a retryable error if the document list fails.
      }
    })();
    return () => request.abort();
  }, [person.id, documentRetry, canLoadDocuments]);
  useEffect(() => {
    if (tab !== "sources" || !canLoadDocuments) return;
    const request = new AbortController();
    void (async () => {
      try {
        const items: Array<{ id: string; title: string }> = [];
        let total = 0;
        do {
          const response = await archiveFetch(
            `/api/documents?personId=${encodeURIComponent(person.id)}&offset=${items.length}&limit=100`,
            { signal: request.signal },
          );
          if (!response.ok)
            throw new Error("Не удалось загрузить документы");
          const page = (await response.json()) as {
            total: number;
            items: Array<{ id: string; title: string }>;
          };
          total = page.total;
          if (!page.items.length && items.length < total)
            throw new Error("Не удалось загрузить все документы");
          items.push(...page.items);
        } while (items.length < total);
        if (!request.signal.aborted)
          setDocuments({
            personId: person.id,
            retry: documentRetry,
            items,
            error: "",
          });
      } catch (reason) {
        if (!request.signal.aborted)
          setDocuments({
            personId: person.id,
            retry: documentRetry,
            items: [],
            error:
              reason instanceof Error
                ? reason.message
                : "Не удалось загрузить документы",
          });
      }
    })();
    return () => request.abort();
  }, [person.id, tab, documentRetry, canLoadDocuments]);
  const documentsCurrent =
    documents.personId === person.id && documents.retry === documentRetry;
  const personDocuments = documentsCurrent ? documents.items : [];
  const documentsLoading = canLoadDocuments && !documentsCurrent;
  const personDocumentCount =
    documentsCurrent && !documents.error
      ? documents.items.length
      : documentCount.personId === person.id &&
          documentCount.retry === documentRetry
        ? documentCount.total
        : 0;
  const sources = collectPersonSources(person);
  const relatives = people.filter(
    (p) =>
      links?.some(
        (l) =>
          (l.from === person.id && l.to === p.id) ||
          (l.to === person.id && l.from === p.id),
      ) ||
      person.parents.includes(p.id) ||
      person.spouses.includes(p.id) ||
      p.spouses.includes(person.id) ||
      p.parents.includes(person.id) ||
      (p.id !== person.id &&
        p.parents.some((id) => person.parents.includes(id))),
  );
  return (
    <>
      <div className="profile-head">
        <Avatar person={person} large />
        {isCurrentUser && <span className="profile-self-label">Это вы</span>}
        <h2>
          {hasRecordedDeath(person) ? (
            <MemorialName key={person.id}>{person.surname}</MemorialName>
          ) : (
            person.surname
          )}
          <span className="profile-given-name">
            {person.name} {person.patronymic}
          </span>
        </h2>
        {(person.maidenName || person.factAlternatives?.some((alternative) =>
          alternative.field === "maidenName")) && (
          <div className="maiden-name">
            {person.maidenName && <>Фамилия при рождении: {person.maidenName}</>}
            {!!person.maidenNameClaim?.sources.length &&
              <p>Источники фамилии при рождении: {claimSummary(person.maidenNameClaim)}</p>}
            {alternativeFacts(person, "maidenName")}
          </div>
        )}
        {years(person) && (
          <p>
            {years(person)}
            {ageLabel(person) && (
              <>
                <span>·</span>
                {ageLabel(person)}
              </>
            )}
          </p>
        )}
        <PersonAwards awards={person.awards} />
      </div>
      {suggestions}
      <div
        className="panel-tabs"
        role="tablist"
        tabIndex={-1}
        aria-label="Сведения о человеке"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]',
            ),
          );
          const index = tabs.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (index < 0) return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    tabs.length) %
                  tabs.length;
          tabs[next].focus();
          tabs[next].click();
        }}
      >
        <button
          role="tab"
          id={`${idPrefix}-bio-tab`}
          aria-controls={`${idPrefix}-tab-content`}
          aria-selected={tab === "bio"}
          tabIndex={tab === "bio" ? 0 : -1}
          className={tab === "bio" ? "active" : ""}
          onClick={() => setTab("bio")}
        >
          О человеке
        </button>
        <button
          role="tab"
          id={`${idPrefix}-sources-tab`}
          aria-controls={`${idPrefix}-tab-content`}
          aria-selected={tab === "sources"}
          tabIndex={tab === "sources" ? 0 : -1}
          className={tab === "sources" ? "active" : ""}
          onClick={() => setTab("sources")}
        >
          Источники{" "}
          <span className="count-badge">
            {sources.length + personDocumentCount}
          </span>
        </button>
        {canDiscuss && (
          <button
            role="tab"
            id={`${idPrefix}-discussion-tab`}
            aria-controls={`${idPrefix}-tab-content`}
            aria-selected={tab === "discussion"}
            tabIndex={tab === "discussion" ? 0 : -1}
            className={tab === "discussion" ? "active" : ""}
            onClick={() => setTab("discussion")}
          >
            Обсуждение{" "}
            <span className="count-badge">{discussionCount.count ?? "…"}</span>
          </button>
        )}
      </div>
      <div
        className="profile-content"
        id={`${idPrefix}-tab-content`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-${tab}-tab`}
      >
        {tab === "bio" ? (
          <>
            {(person.birth || person.birthPlace || person.factAlternatives?.some((alternative) =>
              alternative.field === "birth" || alternative.field === "birthPlace")) && (
              <div className="life-event">
                <span className="event-icon">
                  <Sprout size={13} />
                </span>
                <div>
                  <span className="event-label">Рождение</span>
                  {person.birth && <b>{dateLabel(person.birth)}</b>}
                  {!!person.birthDateClaim?.sources.length &&
                    <p>Источники даты: {claimSummary(person.birthDateClaim)}</p>}
                  {person.birthPlace && <p>{person.birthPlace}</p>}
                  {!!person.birthPlaceClaim?.sources.length &&
                    <p>Источники места: {claimSummary(person.birthPlaceClaim)}</p>}
                  {alternativeFacts(person, "birth")}
                </div>
              </div>
            )}
            {hasRecordedDeath(person) || person.factAlternatives?.some((alternative) =>
              alternative.field === "death" || alternative.field === "deathPlace") ? (
              <div className="life-event">
                <span className="event-icon">†</span>
                <div>
                  <span className="event-label">{hasRecordedDeath(person)
                    ? "Уход из жизни" : "Возможные сведения о смерти"}</span>
                  {person.death && <b>{dateLabel(person.death)}</b>}
                  {!!person.deathDateClaim?.sources.length &&
                    <p>Источники даты: {claimSummary(person.deathDateClaim)}</p>}
                  {person.deathPlace && <p>{person.deathPlace}</p>}
                  {!!person.deathPlaceClaim?.sources.length &&
                    <p>Источники места: {claimSummary(person.deathPlaceClaim)}</p>}
                  {alternativeFacts(person, "death")}
                </div>
              </div>
            ) : person.birth ? (
              <div className="living-note">
                <span className="tiny-dot" />
                История продолжается
              </div>
            ) : null}
            <LifeSpan person={person} />
            {(person.biography || person.occupation || person.factAlternatives?.some((alternative) =>
              alternative.field === "occupation")) && (
              <div className="biography">
                <h3>{person.occupation || "Сохранённая история"}</h3>
                {!!person.occupationClaim?.sources.length &&
                  <p>Источники занятия: {claimSummary(person.occupationClaim)}</p>}
                {alternativeFacts(person, "occupation")}
                {person.biography && <p>{person.biography}</p>}
              </div>
            )}
            <PersonEvents events={person.events} canLoadDocuments={canLoadDocuments} />
            <div className="relatives">
              <h3>
                Семейные связи <span>{relatives.length}</span>
              </h3>
              {relatives.length ? (
                relatives.map((p) => (
                  <button key={p.id} onClick={() => onSelect(p.id)}>
                    <Avatar person={p} />
                    <span>
                      <b>
                        {p.name} {p.surname}
                      </b>
                      <small>
                        {analyzeKinship(person, p, people, links, unions).roles?.[1]
                          .term || edgeLabel(person, p, links)}
                      </small>
                      {links?.filter((link) => link.confidence &&
                        ((link.from === person.id && link.to === p.id) ||
                          (link.to === person.id && link.from === p.id)))
                        .map((link) => <small key={link.id}>
                          Оценка связи «{CONNECTION_NAMES[link.type]}»: {CLAIM_CONFIDENCE_LABELS[link.confidence!]}
                        </small>)}
                    </span>
                    <ChevronRight size={13} />
                  </button>
                ))
              ) : (
                <p className="muted-copy">
                  Родственные связи пока не добавлены.
                </p>
              )}
            </div>
            {onCompare && (
              <button className="full-button" onClick={onCompare}>
                <ArrowDownUp size={14} />
                Узнать родство с другим человеком
              </button>
            )}
          </>
        ) : tab === "discussion" && canDiscuss ? (
          <Suspense fallback={<p className="muted-copy">Загружаем обсуждение…</p>}>
            <PersonDiscussion key={person.id} personId={person.id} onSelect={onSelect} onCountChange={discussionCount.update} />
          </Suspense>
        ) : (
          <>
            <div className="section-label">ДОКУМЕНТЫ И СВИДЕТЕЛЬСТВА</div>
            {documentsLoading && (
              <p className="muted-copy" role="status">
                Загружаем документы…
              </p>
            )}
            {documentsCurrent && documents.error && (
              <div role="alert">
                <p className="muted-copy">{documents.error}</p>
                <button
                  type="button"
                  onClick={() => setDocumentRetry((value) => value + 1)}
                >
                  Повторить
                </button>
              </div>
            )}
            {personDocuments.map((document) => (
              <div className="source-card" key={document.id}>
                <div className="source-type">
                  <FileText size={13} />
                  Документ
                </div>
                <h3>{document.title}</h3>
                <a
                  href={scopedArchivePath(archiveDocumentPath(person.id, document.id))}
                >
                  Открыть файл
                  <ArrowUpRight size={12} />
                </a>
              </div>
            ))}
            {sources.length ? (
              sources.map((s, i) => (
                <div
                  className="source-card"
                  key={`${s.title}-${s.url || s.reference}-${i}`}
                >
                  <div className="source-type">
                    <FileText size={13} />
                    {s.type}
                  </div>
                  <h3>{s.title}</h3>
                  {s.reference && <p>{s.reference}</p>}
                  {(s.origin || s.note || s.repository) && (
                    <small>
                      {[s.origin, repositorySummary(s), s.note].filter(Boolean).join(" · ")}
                    </small>
                  )}
                  {safeUrl(s.url) ? (
                    <a
                      href={archiveResourceUrl(safeUrl(s.url) || "")}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Открыть источник
                      <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    !s.documentId && (
                      <span className="source-unavailable">
                        Ссылка пока не добавлена
                      </span>
                    )
                  )}
                  {canLoadDocuments && s.documentId && (
                    <a href={scopedArchivePath(archiveDocumentPath(null, s.documentId, s.documentPage))}>
                      Открыть документ
                      <ArrowUpRight size={12} />
                    </a>
                  )}
                </div>
              ))
            ) : !personDocuments.length &&
              !documentsLoading &&
              !documents.error ? (
              <div className="empty-sources">
                <BookOpen size={28} strokeWidth={1} />
                <h3>У истории ещё есть пробелы</h3>
                <p>Источники об этом человеке пока не добавлены в архив.</p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
