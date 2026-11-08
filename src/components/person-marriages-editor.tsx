import { useState } from "react";
import { Heart } from "lucide-react";
import {
  dateInputLabel,
  fullName,
  owns,
  canAssessArchiveEvidence,
  type ArchiveUser,
  type Family,
  type FamilyUnion,
  type Person,
} from "../domain";
import { PersonSearch } from "./person-search.tsx";
import { HistoricalDateInput } from "./historical-date-input";

/** Dates belong to a union, never to a person-only marriage event. */
export function PersonMarriagesEditor({
  family,
  person,
  baseline,
  drafts,
  onChange,
  removedIds,
  onRemove,
  removedPartnerIds,
  onRemovePartner,
  user,
  busy,
}: {
  family: Family;
  person: Person;
  baseline: FamilyUnion[];
  drafts: FamilyUnion[];
  onChange: (drafts: FamilyUnion[]) => void;
  removedIds: string[];
  onRemove: (id: string) => void;
  removedPartnerIds: string[];
  onRemovePartner: (id: string) => void;
  user: ArchiveUser | null;
  busy: boolean;
}) {
  const [partnerId, setPartnerId] = useState("");
  const [selectedUnionId, setSelectedUnionId] = useState("");
  const records = [...new Map([...baseline, ...drafts].map(union => [union.id, union])).values()]
    .filter(union => union.type === "marriage" && union.participants.includes(person.id) &&
      !removedIds.includes(union.id) && !union.participants.some(id => removedPartnerIds.includes(id)));
  const partners = family.people.filter(
    (other) =>
      other.id !== person.id &&
      !removedPartnerIds.includes(other.id) &&
      (person.spouses.includes(other.id) ||
        other.spouses.includes(person.id) ||
        baseline.some(
          (union) =>
            union.participants.includes(person.id) &&
            union.participants.includes(other.id),
        )),
  );
  const partner = partners.find((other) => other.id === partnerId);
  const undatedPartners = partners.filter(other =>
    (person.spouses.includes(other.id) || other.spouses.includes(person.id)) &&
    !records.some(union => union.participants.includes(other.id)));
  const marriages = records.filter(
    (union) =>
      union.type === "marriage" &&
      union.participants.includes(person.id) &&
      union.participants.includes(partnerId),
  );
  const selectedMarriage =
    marriages.find((union) => union.id === selectedUnionId) || marriages[0];
  const original = baseline.find(union => union.id === selectedMarriage?.id);
  const draft =
    drafts.find((union) => union.id === (selectedMarriage?.id || selectedUnionId)) ||
    (!original
      ? drafts.find(
          (union) =>
            union.participants.includes(person.id) &&
            union.participants.includes(partnerId) &&
            !baseline.some((item) => item.id === union.id),
        )
      : undefined);
  const shown = draft || original;
  const editable =
    !!partner &&
    owns(user, person) &&
    owns(user, partner) &&
    (!original || owns(user, original));
  const canAssess = canAssessArchiveEvidence(user);
  const changeDate = (key: "formation" | "divorce", value: { date?: string; dateJulian?: string }) => {
    if (!partner || !editable) return;
    const union: FamilyUnion = shown || {
      id: selectedUnionId || crypto.randomUUID(),
      participants: [person.id, partner.id],
      type: "marriage",
    };
    setSelectedUnionId(union.id);
    onChange([
      ...drafts.filter((item) => item.id !== union.id),
      { ...union, [key]: { ...union[key], ...value } },
    ]);
  };
  return (
    <details className="form-details person-marriages-editor">
      <summary>
        <Heart size={17} aria-hidden="true" />
        Брак
      </summary>
      <div className="person-marriage-fields">
        {undatedPartners.length > 0 && <ul className="person-marriages-list" aria-label="Связи супругов без записи о браке">
          {undatedPartners.map(other => <li key={other.id}>
            <button type="button" disabled={busy} onClick={() => {
              setPartnerId(other.id); setSelectedUnionId("");
            }}>{fullName(other)} · Даты не указаны</button>
            <button type="button" disabled={busy || !owns(user, person) || !owns(user, other)}
              onClick={() => { onRemovePartner(other.id); setPartnerId(""); setSelectedUnionId(""); }}
              aria-label={`Удалить связь супругов с ${fullName(other)}`}>Удалить связь</button>
          </li>)}
        </ul>}
        {records.length > 0 && <ul className="person-marriages-list" aria-label="Записи о браках">
          {records.map(union => {
            const other = family.people.find(item => item.id !== person.id && union.participants.includes(item.id));
            const canRemove = (!baseline.some(item => item.id === union.id) || owns(user, union)) && union.participants.every(id => {
              const participant = family.people.find(item => item.id === id);
              return !!participant && owns(user, participant);
            });
            return <li key={union.id}>
              <button type="button" disabled={busy || !other} onClick={() => {
                setPartnerId(other!.id); setSelectedUnionId(union.id);
              }}>
                {other ? fullName(other) : "Супруг не загружен"}
                {union.formation?.date && ` · ${dateInputLabel(union.formation.date)}`}
              </button>
              <button type="button" disabled={busy || !canRemove}
                onClick={() => { onRemove(union.id); setSelectedUnionId(""); }}
                aria-label={`Удалить запись о браке с ${other ? fullName(other) : "супругом"}`}>Удалить</button>
            </li>;
          })}
        </ul>}
        {partners.length ? (
          <>
            <PersonSearch
              people={partners}
              showAllOnEmpty
              value={partnerId}
              selected={partner}
              label="Супруг / супруга"
              inputAriaLabel="Супруг / супруга"
              clearLabel="Выбрать другого супруга"
              disabled={busy}
              onChange={(id) => {
                setPartnerId(id);
                setSelectedUnionId("");
              }}
            />
            {marriages.length > 1 && (
              <label>
                Брак с этим человеком
                <select
                  value={selectedMarriage?.id || ""}
                  onChange={(event) => setSelectedUnionId(event.target.value)}
                >
                  {marriages.map((union, index) => (
                    <option key={union.id} value={union.id}>
                      {union.formation?.dateText ||
                        dateInputLabel(union.formation?.date || "") ||
                        `Брак ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {partner && (
              <>
                <div className="form-grid">
                  {(["formation", "divorce"] as const).map((key) => (
                    <div key={key}>
                      <HistoricalDateInput label={key === "formation" ? "Дата брака" : "Дата развода"}
                        date={shown?.[key]?.date} dateJulian={shown?.[key]?.dateJulian}
                        disabled={
                          busy ||
                          !editable ||
                          (!canAssess && !!shown?.[key]?.confidence) ||
                          (key === "divorce" && !!shown?.ending)
                        }
                        onChange={(value) => changeDate(key, value)}
                      />
                      {shown?.[key]?.dateText && (
                        <small>По источнику: {shown[key]!.dateText}</small>
                      )}
                      {!!shown?.[key]?.confidence && (
                        <small>
                          {canAssess
                            ? "При изменении даты прежняя оценка снимается."
                            : "Оценённую дату может изменить исследователь или администратор."}
                        </small>
                      )}
                    </div>
                  ))}
                </div>
                {!editable && (
                  <small>Нет права изменять союз с {fullName(partner)}.</small>
                )}
                {shown?.ending && (
                  <small>
                    Другое окончание союза уже указано. Его можно изменить в
                    семейных союзах.
                  </small>
                )}
              </>
            )}
          </>
        ) : (
          <p>
            Сначала добавьте супруга в семейные связи. Здесь появится выбор из
            существующих союзов.
          </p>
        )}
      </div>
    </details>
  );
}
