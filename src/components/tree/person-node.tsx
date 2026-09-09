import { createContext, memo, useContext } from "react";
import {
  Handle,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { fullName, years, type Person } from "../../domain";
import { Avatar } from "../person-panel";
export const TreeActions = createContext<{
  choose: (id: string, additive: boolean) => void;
  collapse: (id: string) => void;
}>({
  choose: () => {},
  collapse: () => {},
});
export type PersonNodeType = Node<
  {
    person: Person;
    collapsed: boolean;
    childrenCount: number;
    dimmed: boolean;
    household?: boolean;
  },
  "person"
>;
export const PersonNode = memo(function PersonNode({
  data,
  selected,
  isConnectable,
}: NodeProps<PersonNodeType>) {
  const { choose, collapse } = useContext(TreeActions);
  const compact = useStore((s) => s.transform[2] < 0.65);
  return (
    <div
      className={`flow-person ${selected ? "is-selected" : ""} ${compact ? "is-compact" : ""} ${data.dimmed ? "is-dimmed" : ""}`}
      data-readonly={!isConnectable}
      data-household={data.household || undefined}
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
        onClick={(e) => choose(data.person.id, e.shiftKey)}
        aria-label={`${fullName(data.person)}${years(data.person) ? `, ${years(data.person)}` : ""}`}
      >
        {!compact && <Avatar person={data.person} />}
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
      {!compact && data.childrenCount > 0 && (
        <button
          className="flow-collapse nodrag nopan"
          aria-label={
            data.collapsed ? "Развернуть потомков" : "Свернуть потомков"
          }
          title={data.collapsed ? "Развернуть потомков" : "Свернуть потомков"}
          onClick={() => collapse(data.person.id)}
        >
          {data.collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          <span>{data.childrenCount}</span>
        </button>
      )}
    </div>
  );
});
