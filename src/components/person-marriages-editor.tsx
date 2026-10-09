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

/** Dates belong to a union, never to a person-only marriage event. */
export function PersonMarriagesEditor({
  family,
  person,
  baseline,
  drafts,
  onChange,
  user,
  busy,
}: {
  family: Family;
  person: Person;
  baseline: FamilyUnion[];
  drafts: FamilyUnion[];
  onChange: (drafts: FamilyUnion[]) => void;
  user: ArchiveUser | null;
  busy: boolean;
}) {
  const [partnerId, setPartnerId] = useState("");
  const [selectedUnionId, setSelectedUnionId] = useState("");
  const partners = family.people.filter(
    (other) =>
      other.id !== person.id &&
      (person.spouses.includes(other.id) ||
        other.spouses.includes(person.id) ||
        baseline.some(
          (union) =>
            union.participants.includes(person.id) &&
            union.participants.includes(other.id),
        )),
  );
  const partner = partners.find((other) => other.id === partnerId);
  const marriages = baseline.filter(
    (union) =>
      union.type === "marriage" &&
      union.participants.includes(person.id) &&
      union.participants.includes(partnerId),
  );
  const original =
    marriages.find((union) => union.id === selectedUnionId) || marriages[0];
  const draft =
    drafts.find((union) => union.id === (original?.id || selectedUnionId)) ||
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
  const changeDate = (key: "formation" | "divorce", date: string) => {
    if (!partner || !editable) return;
    const union: FamilyUnion = shown || {
      id: selectedUnionId || crypto.randomUUID(),
      participants: [person.id, partner.id],
      type: "marriage",
    };
    setSelectedUnionId(union.id);
    onChange([
      ...drafts.filter((item) => item.id !== union.id),
      { ...union, [key]: { ...union[key], date: date || undefined } },
    ]);
  };
  return (
    <details className="form-details person-marriages-editor">
      <summary>
        <Heart size={17} aria-hidden="true" />
        Брак
      </summary>
      <div className="person-marriage-fields">
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
                  value={original?.id || ""}
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
                    <label key={key}>
                      {key === "formation" ? "Дата брака" : "Дата развода"}
                      <input
                        value={
                          shown?.[key]?.date
                            ? dateInputLabel(shown[key]!.date!)
                            : ""
                        }
                        disabled={
                          busy ||
                          !editable ||
                          (!canAssess && !!shown?.[key]?.confidence) ||
                          (key === "divorce" && !!shown?.ending)
                        }
                        placeholder="День, месяц, год или только год"
                        onChange={(event) =>
                          changeDate(key, event.target.value)
                        }
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
                    </label>
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
