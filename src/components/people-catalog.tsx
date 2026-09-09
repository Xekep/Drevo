import { useMemo, useState } from "react";
import { ChevronRight, MapPin } from "lucide-react";
import { fullName, plural, type Person } from "../domain";
import {
  directoryPeople,
  directoryYears,
  type PeopleSort,
} from "../domain/people-directory";
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
  const [sort, setSort] = useState<PeopleSort>("name");
  const list = useMemo(
    () => directoryPeople(people, query, sort),
    [people, query, sort],
  );
  const children = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of people)
      for (const id of p.parents) counts.set(id, (counts.get(id) || 0) + 1);
    return counts;
  }, [people]);
  return (
    <section className="people-directory">
      <header>
        <div>
          <span className="section-label">СЕМЕЙНЫЙ АРХИВ</span>
          <h1>
            Люди <small>{list.length}</small>
          </h1>
        </div>
        <label>
          Порядок
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as PeopleSort)}
          >
            <option value="name">Фамилия: А — Я</option>
            <option value="name-desc">Фамилия: Я — А</option>
            <option value="birth">Рождение: раньше → позже</option>
            <option value="birth-desc">Рождение: позже → раньше</option>
            <option value="death">По году смерти</option>
          </select>
        </label>
      </header>
      <div className="directory-columns" aria-hidden="true">
        <span>Человек</span>
        <span>Годы жизни</span>
        <span>Места</span>
        <span>Семья</span>
      </div>
      <ul>
        {list.map((p) => {
          const count = children.get(p.id) || 0,
            life = directoryYears(p);
          return (
            <li key={p.id}>
              <button
                className="directory-person"
                onClick={() => onSelect(p.id)}
              >
                <span className="directory-name">
                  <Avatar person={p} />
                  <span>
                    <b>{fullName(p)}</b>
                    {p.maidenName && (
                      <small>При рождении: {p.maidenName}</small>
                    )}
                  </span>
                </span>
                <span className="directory-years">{life}</span>
                <span className="directory-places">
                  {p.birthPlace && (
                    <small>
                      <MapPin size={12} />
                      {p.birthPlace}
                    </small>
                  )}
                  {p.deathPlace && p.deathPlace !== p.birthPlace && (
                    <small>Место смерти: {p.deathPlace}</small>
                  )}
                </span>
                <span className="directory-family">
                  {count > 0 && (
                    <small>
                      {count} {plural(count, "ребёнок", "ребёнка", "детей")}
                    </small>
                  )}
                  {p.parents.length > 0 && (
                    <small>
                      {p.parents.length === 2
                        ? "Родители указаны"
                        : "Указан родитель"}
                    </small>
                  )}
                </span>
                <ChevronRight className="directory-arrow" size={17} />
              </button>
            </li>
          );
        })}
      </ul>
      {!list.length && (
        <p className="directory-empty">
          {query
            ? "По вашему запросу никто не найден. Попробуйте фамилию при рождении или место."
            : "Здесь появятся участники семейного архива."}
        </p>
      )}
    </section>
  );
}
