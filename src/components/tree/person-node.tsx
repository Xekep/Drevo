import { createContext, memo, useContext, useMemo } from "react";
import {
  Handle,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, ChevronUp, CircleAlert, Copy, Eye, EyeOff, LoaderCircle, Plus } from "lucide-react";
import { fullName, resolvedSex, years, type Person } from "../../domain";
import { useTreePublicationStatus } from "./tree-publication-provider";
import { Avatar } from "../person-panel";
import { PortraitPlaceholder } from "../portrait-placeholder";
import { useLongPress } from "./use-long-press";
import { samePersonNodeData, type PersonNodeData } from "./person-node-data";
import {
  treeNodeSize,
  TREE_NODE_WIDTH,
} from "../../domain/tree-layout-constants";
export const TreeActions = createContext<{
  gpu?: boolean;
  /** Live card details stay independent of the stable layout projection. */
  currentPeople?: ReadonlyMap<string, Person>;
  /** Initial camera placement and large scene handoff precede portrait loading. */
  deferPortraits?: boolean;
  choose: (id: string, additive: boolean) => void;
  selectOnly: (id: string) => void;
  collapse: (id: string, occurrenceId?: string) => void;
  expand: (id: string, occurrenceId?: string) => void;
  reference: (personId: string, occurrenceId: string) => void;
  publishPerson?: (personId: string) => void;
  publicationUpdate?: { personId: string; published: boolean; archiveId: string | null } | null;
  relationLabel: (person: Person) => string;
}>({
  choose: () => {},
  selectOnly: () => {},
  collapse: () => {},
  expand: () => {},
  reference: () => {},
  publishPerson: undefined,
  publicationUpdate: null,
  relationLabel: () => "",
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
  data: nodeData,
  id,
  selected,
  width = TREE_NODE_WIDTH,
  height = treeNodeSize().height,
  isConnectable,
}: NodeProps<PersonNodeType>) {
  const {
    gpu,
    currentPeople,
    deferPortraits,
    choose,
    selectOnly,
    collapse,
    expand,
    reference,
    publishPerson,
    relationLabel: getRelationLabel,
  } = useContext(TreeActions);
  const person = currentPeople?.get(nodeData.person.id) || nodeData.person;
  const data = person === nodeData.person ? nodeData : { ...nodeData, person };
  const longPress = useLongPress(() => selectOnly(data.person.id));
  // Preserve a usable screen target at overview zoom without changing layout.
  const controlScale = useStore((state) =>
    Math.min(6, Math.max(1, Math.ceil(1 / state.transform[2] * 4) / 4)),
  );
  const detail = useStore((s) =>
    s.transform[2] < 0.18
      ? "distant"
      : s.transform[2] < 0.52
        ? "overview"
        : s.transform[2] < 0.75
          ? "compact"
          : "full",
  );
  // React Flow adopts new node props after the parent commit. A cached scope
  // change can briefly leave old NodeWrappers mounted; only nearby portraits
  // may start a request, regardless of that intermediate node list.
  const portraitVisible = useStore((state) => {
    const node = state.nodeLookup.get(id);
    if (!node || !state.width || !state.height) return false;
    const [tx, ty, zoom] = state.transform;
    const x = tx + node.internals.positionAbsolute.x * zoom;
    const y = ty + node.internals.positionAbsolute.y * zoom;
    const right = x + (node.measured?.width || node.width || width) * zoom;
    const bottom = y + (node.measured?.height || node.height || height) * zoom;
    return right >= -128 && bottom >= -128 &&
      x <= state.width + 128 && y <= state.height + 128;
  });
  const { status: publicationStatus, refresh: checkPublication } = useTreePublicationStatus(
    data.person.id, !!publishPerson && portraitVisible,
  );
  const compact = detail !== "full";
  const overview = detail === "overview" || detail === "distant";
  const relationLabel = useMemo(
    () => detail === "distant" ? "" : getRelationLabel(data.person),
    [detail, getRelationLabel, data.person],
  );
  const lifespan = years(data.person);
  const cardLabel = `${fullName(data.person)}${lifespan ? ` ${lifespan}` : ""}${relationLabel ? ` ${relationLabel}` : ""}${data.person.needsReview ? ", требует проверки" : ""}`;
  const branchAction = data.collapsed ? "Развернуть" : "Свернуть";
  const branchTitle = `${branchAction} ветвь`;
  const privacyLabel = publicationStatus === "published" ? "Доступен для поиска"
    : publicationStatus === "hidden" ? "Недоступен для поиска"
    : publicationStatus === "error" ? "Не удалось проверить доступность для поиска"
    : publicationStatus === "loading" ? "Проверяем доступность для поиска"
    : "Проверить доступность для поиска";
  return (
    <div
      className={`flow-person is-portrait-card ${selected ? "is-selected" : ""} ${data.spotlit ? "is-spotlit" : ""} ${data.person.needsReview ? "is-needs-review" : ""} ${data.outsideSpotlight ? "is-outside-spotlight" : ""} ${compact ? "is-compact" : ""} ${overview ? "is-overview" : ""} ${detail === "distant" ? "is-distant" : ""} ${data.dimmed ? "is-dimmed" : ""}`}
      data-readonly={!isConnectable}
      data-person-id={data.person.id}
      data-needs-review={data.person.needsReview || undefined}
      data-household={data.household || undefined}
      data-anchor={data.anchor || undefined}
      style={{ width, height }}
      onMouseEnter={checkPublication}
      onFocusCapture={checkPublication}
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
          aria-hidden="true"
        />
      ))}
      <button
        className="flow-person-content"
        {...longPress.handlers}
        onMouseDownCapture={(event) => {
          // Shift is a selection gesture, even with a little mouse movement.
          // Ordinary drags should reach React Flow and pan from the card too.
          if (event.shiftKey && event.button === 0) {
            event.preventDefault();
            event.stopPropagation();
          }
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
        {detail === "distant" || gpu || deferPortraits || !portraitVisible ? (
          <span
            className={`person-avatar ${resolvedSex(data.person) === "f" ? "female" : resolvedSex(data.person) === "m" ? "male" : "unknown"}`}
            aria-hidden="true"
          >
            {detail === "distant" && !gpu && !deferPortraits && <PortraitPlaceholder compact />}
          </span>
        ) : <Avatar person={data.person} loading="eager" />}
        <span className="portrait-card-info">
          <strong>{fullName(data.person)}</strong>{" "}
          {lifespan && <span className="portrait-card-years">{lifespan}</span>}
          {relationLabel && <>{" "}<small>{relationLabel}</small></>}
        </span>
      </button>
      {publishPerson && (
        <button
          type="button"
          className="flow-privacy nodrag nopan"
          data-publication-state={publicationStatus}
          aria-label={`${privacyLabel}: ${fullName(data.person)}. Изменить приватность`}
          title={`${privacyLabel} · изменить приватность`}
          aria-haspopup="dialog"
          onClick={(event) => {
            event.stopPropagation();
            publishPerson(data.person.id);
          }}
        >
          {publicationStatus === "published" ? <Eye size={18} aria-hidden="true" />
            : publicationStatus === "hidden" ? <EyeOff size={18} aria-hidden="true" />
            : publicationStatus === "error" ? <CircleAlert size={18} aria-hidden="true" />
            : <LoaderCircle size={18} aria-hidden="true" />}
        </button>
      )}
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
      {!data.familyFocus && detail !== "distant" && data.childrenCount > 0 && (
        <button
          className="flow-collapse nodrag nopan"
          style={{ transform: `scale(${controlScale})`, transformOrigin: "right bottom" }}
          aria-label={`${branchTitle}: ${data.childrenCount} потомков`}
          title={branchTitle}
          onClick={() => collapse(data.person.id, id)}
        >
          {data.collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          <span>{data.childrenCount}</span>
        </button>
      )}
    </div>
  );
}, samePersonNodeProps);
