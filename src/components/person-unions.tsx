import { Heart } from "lucide-react";
import { dateLabel, fullName } from "../domain/dates";
import { CLAIM_CONFIDENCE_LABELS } from "../domain/claim-confidence";
import type { FamilyUnion, Person, UnionMilestone } from "../domain/types";
import { EventSourceList } from "./person-events";
import { researchEvidenceAnchor } from "../domain/research-evidence";

const names = {
  marriage: "Брак",
  civil_union: "Гражданский союз",
  partnership: "Партнёрство",
} as const;

/** Both profiles read the same union; no mirrored personal events are stored. */
export function PersonUnions({ personId, people, unions, onSelect, canLoadDocuments }: {
  personId: string;
  people: Person[];
  unions?: FamilyUnion[];
  onSelect: (id: string) => void;
  canLoadDocuments: boolean;
}) {
  const known = new Map(people.map((person) => [person.id, person]));
  const records = (unions || []).filter((union) => union.participants.includes(personId)
    && union.participants.every((id) => known.has(id)));
  if (!records.length) return null;
  const milestone = (label: string, value: UnionMilestone | undefined) => value && (
    <div className="person-union-milestone">
      <b>{label}: {value.date ? dateLabel(value.date) : value.dateText || "дата неизвестна"}</b>
      {value.date && value.dateText && <p>По источнику: {value.dateText}</p>}
      {value.place && <p>{value.place}</p>}
      {value.confidence && <p>Оценка: {CLAIM_CONFIDENCE_LABELS[value.confidence]}</p>}
      {!!value.sources?.length && <EventSourceList label={`Источники: ${label.toLocaleLowerCase("ru")}`}
        sources={value.sources} canLoadDocuments={canLoadDocuments} />}
    </div>
  );
  return <section className="person-events person-unions" aria-label="Брак и союзы">
    <h3>Брак и союзы</h3>
    {[...records].sort((a, b) => (a.formation?.date || "9999").localeCompare(b.formation?.date || "9999")
      || a.id.localeCompare(b.id)).map((union) => {
      const partner = known.get(union.participants.find((id) => id !== personId)!)!;
      return <article className="life-event" key={union.id} data-evidence={researchEvidenceAnchor("union", union.id)} tabIndex={-1}>
        <span className="event-icon"><Heart size={14} aria-hidden="true" /></span>
        <div>
          <span className="event-label">{names[union.type]}</span>
          <button type="button" className="person-union-partner" onClick={() => onSelect(partner.id)}>
            {fullName(partner)}
          </button>
          {milestone(union.type === "marriage" ? "Заключение брака" : "Начало союза", union.formation)}
          {milestone("Развод", union.divorce)}
          {milestone("Окончание союза", union.ending)}
          {milestone("Союз продолжался", union.ongoing)}
          {union.confidence && <p>Оценка союза: {CLAIM_CONFIDENCE_LABELS[union.confidence]}</p>}
          {union.note && <p className="event-story">{union.note}</p>}
          {!!union.sources?.length && <EventSourceList label="Источники союза"
            sources={union.sources} canLoadDocuments={canLoadDocuments} />}
        </div>
      </article>;
    })}
  </section>;
}
