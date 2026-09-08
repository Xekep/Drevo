import {
  ArrowDown,
  ArrowDownUp,
  ArrowRight,
  Maximize2,
  Plus,
  TreeDeciduous,
  X,
} from "lucide-react";
import {
  edgeLabel,
  fullName,
  plural,
  years,
  type Person,
  type Relation,
  type FamilyLink,
} from "../domain";
import { Avatar } from "./person-panel";
export function ComparisonPanel({
  selected,
  relation,
  people,
  links,
  onRemove,
  onReveal,
}: {
  selected: Person[];
  relation: Relation | null;
  people: Person[];
  links?: FamilyLink[];
  onRemove: (id: string) => void;
  onReveal: () => void;
}) {
  const map = new Map(people.map((p) => [p.id, p]));
  return (
    <div className="comparison-content">
      <span className="comparison-symbol">
        <ArrowDownUp size={23} strokeWidth={1.3} />
      </span>
      <h2>Как мы связаны</h2>
      <p className="compare-intro">
        Две истории. Найдём то,
        <br />
        что их объединяет.
      </p>
      <div className="comparison-people">
        {[0, 1].map((i) =>
          selected[i] ? (
            <div className="selected-person" key={selected[i].id}>
              <Avatar person={selected[i]} />
              <div>
                <b>
                  {selected[i].name} {selected[i].surname}
                </b>
                <span>{years(selected[i])}</span>
              </div>
              <button
                aria-label={`Убрать ${fullName(selected[i])} из сравнения`}
                onClick={() => onRemove(selected[i].id)}
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <div className="empty-person" key={i}>
              <span>{i + 1}</span>
              <p>
                Выберите {i === 0 ? "первого" : "второго"}
                <br />
                человека на древе
              </p>
              <Plus size={15} />
            </div>
          ),
        )}
      </div>
      {relation ? (
        <>
          <div className={`relation-result ${relation.kind}`} role="status">
            <span className="section-label">
              {relation.kind === "unknown"
                ? "НУЖНО БОЛЬШЕ ДАННЫХ"
                : "СВЯЗЬ НАЙДЕНА"}
            </span>
            <h3>{relation.title}</h3>
            {relation.roles && (
              <div className="relation-directions">
                {relation.roles.map((role, i) => (
                  <div className="relation-direction" key={selected[i].id}>
                    <div>
                      <span>{selected[i].name}</span>
                      <ArrowRight size={10} />
                      <span>{selected[1 - i].name}</span>
                    </div>
                    <strong>{role.term}</strong>
                    <p>{role.description}</p>
                    {role.aliases?.length ? (
                      <small>Также: {role.aliases.join(", ")}</small>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            <p>{relation.explanation}</p>
            {relation.otherRelations?.map((extra, i) => (
              <div key={i} className="additional-relation">
                <b>{extra.title}</b>
                <p>{extra.explanation}</p>
                {extra.roles?.map((role, j) => (
                  <p key={j}>
                    {selected[j].name}: {role.term}
                  </p>
                ))}
              </div>
            ))}
          </div>
          {relation.path.length > 0 && (
            <>
              <div className="path-heading">
                <span className="section-label">ЦЕПОЧКА РОДСТВА</span>
                <span>
                  {relation.path.length - 1}{" "}
                  {plural(relation.path.length - 1, "связь", "связи", "связей")}
                </span>
              </div>
              <ol className="kinship-path">
                {relation.path.map((id, i) => {
                  const p = map.get(id)!;
                  return (
                    <li
                      key={id}
                      className={
                        relation.common.includes(id) ? "common-ancestor" : ""
                      }
                    >
                      {i > 0 && (
                        <div className="path-edge">
                          <ArrowDown size={10} />
                          {edgeLabel(map.get(relation.path[i - 1])!, p, links)}
                        </div>
                      )}
                      <div className="path-person">
                        <span className="path-dot" />
                        <span>
                          <b>
                            {p.name} {p.surname}
                          </b>
                          <small>
                            {years(p)}
                            {relation.common.includes(id) && " · общий предок"}
                          </small>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <button className="full-button" onClick={onReveal}>
                <Maximize2 size={13} />
                Показать цепочку на древе
              </button>
            </>
          )}
          <p className="comparison-footnote">
            Анализ по связям, указанным в семейном архиве.
          </p>
        </>
      ) : (
        <div className="comparison-hint">
          <TreeDeciduous size={25} strokeWidth={1} />
          <p>
            Нажмите на карточку в древе.
            <br />
            Можно также выбрать двух людей
            <br />с зажатой клавишей Shift.
          </p>
        </div>
      )}
    </div>
  );
}
