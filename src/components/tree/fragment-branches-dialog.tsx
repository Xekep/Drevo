import { useMemo, useState } from "react";
import { ArrowRight, GitBranch, Plus } from "lucide-react";
import type { Person } from "../../domain/types";
import { fullName } from "../../domain/dates";
import type { FragmentContinuation } from "../../domain/tree-fragment";
import { EditorDialog } from "../editor-dialog";
import { LoadMore, useListLimit } from "../load-more";

/** Navigates only actual one-edge continuations in the authorized projection. */
export function FragmentBranchesDialog({
  owner,
  people,
  continuation,
  owners,
  onOwner,
  atLimit,
  expanded,
  onExpand,
  onChoose,
  onClose,
}: {
  owner: Person;
  people: ReadonlyMap<string, Person>;
  continuation: FragmentContinuation | undefined;
  owners: string[];
  onOwner: (id: string) => void;
  atLimit: boolean;
  expanded: boolean;
  onExpand: () => void;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const groups = [
      ["parents", "Родитель"],
      ["children", "Ребёнок"],
      ["partners", "Партнёр"],
      ["other", "Дополнительная связь"],
    ] as const;
    const normalized = query
      .trim()
      .toLocaleLowerCase("ru")
      .replaceAll("ё", "е");
    return groups.flatMap(([key, label]) =>
      (continuation?.[key] || []).flatMap((id) => {
        const person = people.get(id);
        return person &&
          fullName(person)
            .toLocaleLowerCase("ru")
            .replaceAll("ё", "е")
            .includes(normalized)
          ? [{ person, label }]
          : [];
      }),
    );
  }, [continuation, people, query]);
  const { limit, more } = useListLimit(`${owner.id}:${query}`);
  return (
    <EditorDialog
      title="Продолжение ветвей"
      onClose={onClose}
      dismissOnOutside
      className="fragment-branches-dialog"
    >
      <label className="tree-generation-toggle">
        <span>
          <GitBranch size={16} aria-hidden="true" /> Через кого продолжить
        </span>
        <select
          aria-label="Продолжение через человека"
          value={owner.id}
          onChange={(event) => onOwner(event.target.value)}
        >
          {owners.map((id) => (
            <option key={id} value={id}>
              {fullName(people.get(id)!)}
            </option>
          ))}
        </select>
      </label>
      {atLimit && (
        <p className="muted-copy">
          Фрагмент заполнен. Выберите человека, чтобы продолжить древо от него.
        </p>
      )}
      {(!atLimit || expanded) && (
        <button
          type="button"
          onClick={onExpand}
          disabled={!continuation && !expanded}
        >
          <Plus size={16} />{" "}
          {expanded ? "Свернуть раскрытую ветвь" : "Раскрыть ветви здесь"}
        </button>
      )}
      <input
        type="search"
        aria-label="Найти в продолжении ветвей"
        placeholder="Имя или фамилия"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul>
        {rows.slice(0, limit).map(({ person, label }) => (
          <li key={person.id}>
            <button type="button" onClick={() => onChoose(person.id)}>
              <span>
                <strong>{fullName(person)}</strong>
                <small>{label}</small>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {!rows.length && (
        <p role="status">Непоказанных родственников по этому запросу нет.</p>
      )}
      {limit < rows.length && <LoadMore onMore={more} />}
    </EditorDialog>
  );
}
