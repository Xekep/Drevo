import { useState } from "react";
import { Sparkles } from "lucide-react";
import {
  birthSurnameHints,
  parentHints,
  marriageHints,
  siblingHints,
  fullName,
  owns,
  canChangeConnection,
  type Family,
  type Person,
  type ArchiveUser,
  type Connection,
} from "../domain";
import { SiblingSuggestions } from "./sibling-suggestions";

export function PersonHints({
  person,
  family,
  user,
  busy,
  save,
  onConnection,
}: {
  person: Person;
  family: Family;
  user: ArchiveUser | null;
  busy: boolean;
  save: (family: Family) => Promise<Family>;
  onConnection: (connection: Connection & { hint?: string }) => void;
}) {
  const [error, setError] = useState("");
  const surnames = owns(user, person)
    ? birthSurnameHints(person, family.people)
    : [];
  const parents = parentHints(person, family.people, family.links).filter((h) =>
    canChangeConnection(family, user, { ...h, type: "parent" }),
  );
  const marriages = marriageHints(person, family.people).filter((h) =>
    canChangeConnection(family, user, {
      from: person.id,
      to: h.person.id,
      type: "spouse",
    }),
  );
  const siblings = owns(user, person)
    ? siblingHints(person, family.people, family.links)
    : [];
  const count =
    surnames.length + parents.length + marriages.length + siblings.length;
  if (!count) return null;
  return (
    <details className="profile-hints" open>
      <summary>
        <Sparkles size={15} />
        Можно уточнить · {count}
      </summary>
      {surnames.map(({ surname, parent }) => (
        <div key={surname}>
          <p>
            Фамилия при рождении — <b>{surname}</b>?
          </p>
          <small>По фамилии отца: {fullName(parent)}.</small>
          <button
            disabled={busy}
            onClick={async () => {
              try {
                setError("");
                await save({
                  ...family,
                  people: family.people.map((p) =>
                    p.id === person.id ? { ...p, maidenName: surname } : p,
                  ),
                });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Да, указать {surname}
          </button>
        </div>
      ))}
      {parents.map((hint) => (
        <div key={`${hint.from}:${hint.to}`}>
          <p>
            {hint.role === "father"
              ? "Возможный отец"
              : hint.role === "mother"
                ? "Возможная мать"
                : "Возможный ребёнок"}
            : <b>{fullName(hint.person)}</b>
          </p>
          <small>{hint.reason}</small>
          <button
            disabled={busy}
            onClick={() =>
              onConnection({
                from: hint.from,
                to: hint.to,
                type: "parent",
                hint: hint.reason,
              })
            }
          >
            Проверить связь
          </button>
        </div>
      ))}
      {marriages.map((hint) => (
        <div key={hint.person.id}>
          <p>
            Был ли брак с <b>{fullName(hint.person)}</b>?
          </p>
          <small>
            В архиве указаны общие дети:{" "}
            {hint.children.map((p) => p.name).join(", ")}. Записи о браке пока
            нет.
          </small>
          <button
            disabled={busy}
            onClick={() =>
              onConnection({
                from: person.id,
                to: hint.person.id,
                type: "spouse",
                hint: "Указаны общие дети. Подтвердите брак, только если он действительно был.",
              })
            }
          >
            Указать брак
          </button>
        </div>
      ))}
      <SiblingSuggestions
        hints={siblings}
        busy={busy}
        onParents={(hint) => {
          const knownParent = hint.person.parents.find(
            (id) => !person.parents.includes(id),
          );
          onConnection({
            from: knownParent || "",
            to: person.id,
            type: "parent",
            hint: `Возможное родство с ${fullName(hint.person)}. ${hint.reason} Выберите реально известного общего родителя; неизвестного придумывать не нужно.`,
          });
        }}
      />
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
