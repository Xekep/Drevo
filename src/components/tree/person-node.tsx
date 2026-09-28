import { createContext, memo, useContext, useMemo } from "react";
import {
  Handle,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, ChevronUp, Copy, Plus } from "lucide-react";
import {
  analyzeKinship,
  fullName,
  years,
  type TreeCardVariant,
  type Person,
  type FamilyLink,
} from "../../domain";
import { Avatar } from "../person-panel";
import { useLongPress } from "./use-long-press";
import { samePersonNodeData, type PersonNodeData } from "./person-node-data";
import {
  TREE_NODE_HEIGHT,
  TREE_NODE_WIDTH,
} from "../../domain/tree-layout-constants";
export const TreeActions = createContext<{
  choose: (id: string, additive: boolean) => void;
  selectOnly: (id: string) => void;
  collapse: (id: string, occurrenceId?: string) => void;
  expand: (id: string, occurrenceId?: string) => void;
  reference: (personId: string, occurrenceId: string) => void;
  cardVariant: TreeCardVariant;
  kinshipReference: Person | null;
  kinshipPeople: Person[];
  kinshipLinks: FamilyLink[];
}>({
  choose: () => {},
  selectOnly: () => {},
  collapse: () => {},
  expand: () => {},
  reference: () => {},
  cardVariant: "classic",
  kinshipReference: null,
  kinshipPeople: [],
  kinshipLinks: [],
});
export type PersonNodeType = Node<PersonNodeData, "person">;

function samePersonNodeProps(
  a: NodeProps<PersonNodeType>,
  b: NodeProps<PersonNodeType>,
) {
  // Координаты и прочие служебные props ReactFlow относятся к внешней обёртке.
  // Внутренняя карточка зависит только от этих входов. Context и useStore при
  // необходимости всё равно инициируют собственный render.
  return (
    a.id === b.id &&
    a.selected === b.selected &&
    a.width === b.width &&
    a.height === b.height &&
    a.isConnectable === b.isConnectable &&
    samePersonNodeData(a.data, b.data)
  );
}

export const PersonNode = memo(function PersonNode({
  data,
  id,
  selected,
  width = TREE_NODE_WIDTH,
  height = TREE_NODE_HEIGHT,
  isConnectable,
}: NodeProps<PersonNodeType>) {
  const {
    choose,
    selectOnly,
    collapse,
    expand,
    reference,
    cardVariant,
    kinshipReference,
    kinshipPeople,
    kinshipLinks,
  } = useContext(TreeActions);
  const longPress = useLongPress(() => selectOnly(data.person.id));
  const detail = useStore((s) =>
    s.transform[2] < 0.18
      ? "distant"
      : s.transform[2] < 0.52
        ? "overview"
        : s.transform[2] < 0.75
          ? "compact"
          : "full",
  );
  const compact = detail !== "full";
  const overview = detail === "overview" || detail === "distant";
  const portraitCard = cardVariant === "portrait";
  const relationLabel = useMemo(() => {
    if (!portraitCard) return "";
    if (!kinshipReference) return "Нет привязки к древу";
    if (data.person.id === kinshipReference.id) return "Это вы";
    const relation = analyzeKinship(
      data.person,
      kinshipReference,
      kinshipPeople,
      kinshipLinks,
    );
    const label =
      relation.roles?.[0]?.term ||
      (relation.kind === "unknown"
        ? "Родство не установлено"
        : "Семейная связь");
    return label[0].toLocaleUpperCase("ru") + label.slice(1);
  }, [
    portraitCard,
    data.person,
    kinshipReference,
    kinshipPeople,
    kinshipLinks,
  ]);
  const cardLabel = `${fullName(data.person)}${years(data.person) ? `, ${years(data.person)}` : ""}${portraitCard ? `, ${relationLabel}` : ""}`;
  return (
    <div
      className={`flow-person ${selected ? "is-selected" : ""} ${data.spotlit ? "is-spotlit" : ""} ${data.outsideSpotlight ? "is-outside-spotlight" : ""} ${compact ? "is-compact" : ""} ${overview ? "is-overview" : ""} ${detail === "distant" ? "is-distant" : ""} ${data.dimmed ? "is-dimmed" : ""} ${portraitCard ? "is-portrait-card" : ""}`}
      data-readonly={!isConnectable}
      data-person-id={data.person.id}
      data-household={data.household || undefined}
      data-anchor={data.anchor || undefined}
      style={{ width, height }}
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
        className="flow-person-content nopan"
        {...longPress.handlers}
        onMouseDown={(event) => {
          if (event.shiftKey) event.preventDefault();
        }}
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
        aria-label={cardLabel}
        title={cardLabel}
      >
        {portraitCard ? (
          <>
            <Avatar person={data.person} />
            <span className="portrait-card-info">
              <strong>{fullName(data.person)}</strong>
              <small>{relationLabel}</small>
            </span>
          </>
        ) : (
          <>
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
          </>
        )}
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
