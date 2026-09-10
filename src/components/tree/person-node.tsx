import { createContext, memo, useContext } from "react";
import {
  Handle,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, ChevronUp, Copy, Plus } from "lucide-react";
import { fullName, years, type Person } from "../../domain";
import { Avatar } from "../person-panel";
import { useLongPressCompare } from "./use-long-press-compare";
export const TreeActions = createContext<{
  choose: (id: string, additive: boolean) => void;
  collapse: (id: string, occurrenceId?: string) => void;
  expand: (id: string, occurrenceId?: string) => void;
  reference: (personId: string, occurrenceId: string) => void;
}>({
  choose: () => {},
  collapse: () => {},
  expand: () => {},
  reference: () => {},
});
export type PersonNodeType = Node<
  {
    person: Person;
    collapsed: boolean;
    childrenCount: number;
    dimmed: boolean;
    household?: boolean;
    occurrences?: number;
    familyFocus?: boolean;
    anchor?: boolean;
    hiddenRelatives?: number;
    expanded?: boolean;
  },
  "person"
>;

export function samePersonNodeData(
  a: PersonNodeType["data"],
  b: PersonNodeType["data"],
) {
  return (
    a.person === b.person &&
    a.collapsed === b.collapsed &&
    a.childrenCount === b.childrenCount &&
    a.dimmed === b.dimmed &&
    a.household === b.household &&
    a.occurrences === b.occurrences &&
    a.familyFocus === b.familyFocus &&
    a.anchor === b.anchor &&
    a.hiddenRelatives === b.hiddenRelatives &&
    a.expanded === b.expanded
  );
}

function samePersonNodeProps(
  a: NodeProps<PersonNodeType>,
  b: NodeProps<PersonNodeType>,
) {
  // Координаты и прочие служебные props ReactFlow относятся к внешней обёртке.
  // Внутренняя карточка зависит только от этих четырёх входов. Context и
  // useStore при необходимости всё равно инициируют собственный render.
  return (
    a.id === b.id &&
    a.selected === b.selected &&
    a.isConnectable === b.isConnectable &&
    samePersonNodeData(a.data, b.data)
  );
}

export const PersonNode = memo(function PersonNode({
  data,
  id,
  selected,
  isConnectable,
}: NodeProps<PersonNodeType>) {
  const { choose, collapse, expand, reference } = useContext(TreeActions);
  const longPress = useLongPressCompare(() => choose(data.person.id, true));
  const detail = useStore((s) =>
    s.transform[2] < 0.18
      ? "distant"
      : s.transform[2] < 0.32
        ? "overview"
        : s.transform[2] < 0.65
          ? "compact"
          : "full",
  );
  const compact = detail !== "full";
  const overview = detail === "overview" || detail === "distant";
  return (
    <div
      className={`flow-person ${selected ? "is-selected" : ""} ${compact ? "is-compact" : ""} ${overview ? "is-overview" : ""} ${detail === "distant" ? "is-distant" : ""} ${data.dimmed ? "is-dimmed" : ""}`}
      data-readonly={!isConnectable}
      data-household={data.household || undefined}
      data-anchor={data.anchor || undefined}
    >
      {[
        ["top", Position.Top],
        ["bottom", Position.Bottom],
        ["left", Position.Left],
        ["right", Position.Right],
      ].map(([id, position]) => (
        <Handle
          key={id}
          id={id}
          position={position as Position}
          type="source"
          isConnectable={isConnectable}
          aria-label={`Связать: ${fullName(data.person)}`}
        />
      ))}
      <button
        className="flow-person-content"
        {...longPress.handlers}
        onContextMenu={(event) => {
          if (longPress.active() || longPress.suppressClick.current)
            event.preventDefault();
        }}
        onClick={(event) => {
          if (longPress.suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            longPress.suppressClick.current = false;
            return;
          }
          choose(data.person.id, event.shiftKey);
        }}
        aria-label={`${fullName(data.person)}${years(data.person) ? `, ${years(data.person)}` : ""}`}
      >
        {!overview && <Avatar person={data.person} />}
        <span>
          <strong>{data.person.surname}</strong>
          <span>
            {data.person.name} {!compact && data.person.patronymic}
          </span>
          {!compact && years(data.person) && (
            <small>{years(data.person)}</small>
          )}
        </span>
      </button>
      {(data.occurrences || 0) > 1 && (
        <button
          className="flow-reference nodrag nopan"
          title="Этот же человек показан в нескольких семьях. Перейти к следующей карточке"
          aria-label={`${fullName(data.person)}: перейти к другому отображению, всего ${data.occurrences}`}
          onClick={() => reference(data.person.id, id)}
        >
          <Copy size={12} />
          <span>{data.occurrences}</span>
        </button>
      )}
      {data.familyFocus && (!!data.hiddenRelatives || data.expanded) && (
        <button
          className="flow-expand-family nodrag nopan"
          aria-label={`${data.expanded ? "Свернуть раскрытую ветвь" : `Показать ещё ${data.hiddenRelatives} родственников`}: ${fullName(data.person)}`}
          onClick={() => expand(data.person.id, id)}
          title={
            data.expanded
              ? "Свернуть раскрытую ветвь"
              : "Показать скрытых родственников"
          }
        >
          {data.expanded ? <ChevronUp size={15} /> : <Plus size={15} />}
          <span>
            {data.expanded ? "Свернуть" : `Ещё ${data.hiddenRelatives}`}
          </span>
        </button>
      )}
      {!data.familyFocus && !compact && data.childrenCount > 0 && (
        <button
          className="flow-collapse nodrag nopan"
          aria-label={
            data.collapsed ? "Развернуть потомков" : "Свернуть потомков"
          }
          title={data.collapsed ? "Развернуть потомков" : "Свернуть потомков"}
          onClick={() => collapse(data.person.id, id)}
        >
          {data.collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          <span>{data.childrenCount}</span>
        </button>
      )}
    </div>
  );
}, samePersonNodeProps);
