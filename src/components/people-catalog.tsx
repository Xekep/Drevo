import { fullName, years, matchesPerson, type Person } from "../domain";
import { Avatar } from "./person-panel";
export function PeopleCatalog({
  people,
  query,
  onSelect,
}: {
  people: Person[];
  query: string;
  onSelect: (id: string) => void;
}) {
  const list = people
    .filter((p) => matchesPerson(p, query))
    .sort((a, b) => fullName(a).localeCompare(fullName(b), "ru"));
  return (
    <section className="people-catalog">
      <h1>
        Люди <small>{list.length}</small>
      </h1>
      <div>
        {list.map((p) => (
          <button key={p.id} onClick={() => onSelect(p.id)}>
            <Avatar person={p} />
            <span>
              <b>{fullName(p)}</b>
              {years(p) && <small>{years(p)}</small>}
              {p.birthPlace && <small>{p.birthPlace}</small>}
            </span>
          </button>
        ))}
      </div>
      {!list.length && <p>Здесь появятся участники семейного архива.</p>}
    </section>
  );
}
