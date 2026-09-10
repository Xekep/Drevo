import { useMemo, useState } from "react";
import { familyGroups, fullName, years, type Person } from "../domain";
import { Avatar } from "./person-panel";
import { LoadMore, useListLimit } from "./load-more";
export function FamiliesCatalog({
  people,
  onPerson,
  onReveal,
}: {
  people: Person[];
  onPerson: (id: string) => void;
  onReveal: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const { limit, more } = useListLimit(query);
  const allGroups = useMemo(() => familyGroups(people), [people]);
  const groups = allGroups.filter((g) =>
    [...g.parents, ...g.children].some((p) =>
      fullName(p)
        .toLocaleLowerCase("ru")
        .includes(query.toLocaleLowerCase("ru")),
    ),
  );
  return (
    <section className="gallery-view">
      <div className="gallery-heading">
        <div>
          <span className="section-label">РОДИТЕЛИ И ДЕТИ</span>
          <h2>Семьи</h2>
          <p>
            Каждая группа собирается из известных родителей и их детей. Один
            человек может входить в несколько семей.
          </p>
        </div>
        <label className="family-search">
          Найти семью
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Фамилия или имя"
          />
        </label>
      </div>
      <div className="family-catalog">
        {groups.slice(0, limit).map((g) => (
          <article className="family-group" key={g.id}>
            <div className="section-label">
              {g.parents.length === 1
                ? "ИЗВЕСТНЫЙ РОДИТЕЛЬ"
                : "РОДИТЕЛИ / СУПРУГИ"}
            </div>
            {g.parents.map((p) => (
              <button
                className="family-person"
                key={p.id}
                onClick={() => onPerson(p.id)}
              >
                <Avatar person={p} />
                <span>
                  <b>{fullName(p)}</b>
                  <small>{years(p)}</small>
                </span>
              </button>
            ))}
            <div className="family-children">
              <div className="section-label">ДЕТИ · {g.children.length}</div>
              {g.children.length ? (
                g.children.map((p) => (
                  <button key={p.id} onClick={() => onPerson(p.id)}>
                    {fullName(p)} <small>{p.birth.slice(0, 4)}</small>
                  </button>
                ))
              ) : (
                <p>Дети пока не указаны.</p>
              )}
            </div>
            <button
              className="full-button"
              onClick={() =>
                onReveal([...g.parents, ...g.children].map((p) => p.id))
              }
            >
              Показать семью на древе
            </button>
          </article>
        ))}
      </div>
      {groups.length > limit && <LoadMore onMore={more} />}
      {groups.length === 0 && (
        <p className="gallery-empty">
          {query
            ? "Семьи не найдены."
            : "Добавьте связи родителей и детей или супругов — здесь появятся семьи."}
        </p>
      )}
    </section>
  );
}
