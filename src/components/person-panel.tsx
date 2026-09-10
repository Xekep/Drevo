import { useState, type ReactNode } from "react";
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
  type FamilyLink,
} from "../domain";
import { PortraitPlaceholder } from "./portrait-placeholder";
import { PersonAwards } from "./person-awards";
import { PersonEvents } from "./person-events";
import { MemorialName } from "./memorial-name";
import { mediaPreview } from "../domain/media-preview";
export function Avatar({
  person,
  large = false,
}: {
  person: Person;
  large?: boolean;
}) {
  const [failed, setFailed] = useState<string>();
  const src = mediaPreview(safeUrl(person.photo));
  return (
    <span
      className={`${large ? "profile-avatar" : "person-avatar"} ${resolvedSex(person) === "u" ? "unknown" : resolvedSex(person) === "f" ? "female" : "male"}`}
    >
      {/* Native image keeps optional archive photos independent of an image service. */}
      {src && failed !== src ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} />
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
  onSelect,
  onCompare,
  suggestions,
}: {
  person: Person;
  people: Person[];
  links?: FamilyLink[];
  onSelect: (id: string) => void;
  onCompare: () => void;
  suggestions?: ReactNode;
}) {
  const [tab, setTab] = useState<"bio" | "sources">("bio");
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
        {person.maidenName && (
          <div className="maiden-name">
            Фамилия при рождении: {person.maidenName}
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
      </div>
      {suggestions}
      <div
        className="panel-tabs"
        role="tablist"
        aria-label="Сведения о человеке"
      >
        <button
          role="tab"
          id="bio-tab"
          aria-controls="person-tab-content"
          aria-selected={tab === "bio"}
          className={tab === "bio" ? "active" : ""}
          onClick={() => setTab("bio")}
        >
          О человеке
        </button>
        <button
          role="tab"
          id="sources-tab"
          aria-controls="person-tab-content"
          aria-selected={tab === "sources"}
          className={tab === "sources" ? "active" : ""}
          onClick={() => setTab("sources")}
        >
          Источники <span className="count-badge">{person.sources.length}</span>
        </button>
      </div>
      <div
        className="profile-content"
        id="person-tab-content"
        role="tabpanel"
        aria-labelledby={tab === "bio" ? "bio-tab" : "sources-tab"}
      >
        {tab === "bio" ? (
          <>
            {(person.birth || person.birthPlace) && (
              <div className="life-event">
                <span className="event-icon">
                  <Sprout size={13} />
                </span>
                <div>
                  <span className="event-label">Рождение</span>
                  {person.birth && <b>{dateLabel(person.birth)}</b>}
                  {person.birthPlace && <p>{person.birthPlace}</p>}
                </div>
              </div>
            )}
            {hasRecordedDeath(person) ? (
              <div className="life-event">
                <span className="event-icon">†</span>
                <div>
                  <span className="event-label">Уход из жизни</span>
                  {person.death && <b>{dateLabel(person.death)}</b>}
                  {person.deathPlace && <p>{person.deathPlace}</p>}
                </div>
              </div>
            ) : person.birth ? (
              <div className="living-note">
                <span className="tiny-dot" />
                История продолжается
              </div>
            ) : null}
            <LifeSpan person={person} />
            {(person.biography || person.occupation) && (
              <div className="biography">
                <h3>{person.occupation || "Сохранённая история"}</h3>
                {person.biography && <p>{person.biography}</p>}
              </div>
            )}
            <PersonAwards awards={person.awards} />
            <PersonEvents events={person.events} />
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
                        {analyzeKinship(person, p, people, links).roles?.[1]
                          .term || edgeLabel(person, p, links)}
                      </small>
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
            <button className="full-button" onClick={onCompare}>
              <ArrowDownUp size={14} />
              Узнать родство с другим человеком
            </button>
          </>
        ) : (
          <>
            <div className="section-label">ДОКУМЕНТЫ И СВИДЕТЕЛЬСТВА</div>
            {person.sources.length ? (
              person.sources.map((s, i) => (
                <div className="source-card" key={`${s.title}-${i}`}>
                  <div className="source-type">
                    <FileText size={13} />
                    {s.type}
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.reference}</p>
                  {s.note && <small>{s.note}</small>}
                  {safeUrl(s.url) ? (
                    <a
                      href={safeUrl(s.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Открыть источник
                      <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    <span className="source-unavailable">
                      Ссылка пока не добавлена
                    </span>
                  )}
                </div>
              ))
            ) : (
              <div className="empty-sources">
                <BookOpen size={28} strokeWidth={1} />
                <h3>У истории ещё есть пробелы</h3>
                <p>Источники об этом человеке пока не добавлены в архив.</p>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
