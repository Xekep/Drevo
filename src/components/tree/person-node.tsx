import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Handle,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, ChevronUp, CircleHelp, Copy, Eye, EyeOff, LoaderCircle, Plus } from "lucide-react";
import { fullName, resolvedSex, years, type Person } from "../../domain";
import { archiveFetch } from "../../data/archive-fetch.ts";
import { archiveContextAt, archiveResourceUrl } from "../../domain/archive-context.ts";
import { Avatar } from "../person-panel";
import { useLongPress } from "./use-long-press";
import { samePersonNodeData, type PersonNodeData } from "./person-node-data";
import {
  treeNodeSize,
  TREE_NODE_WIDTH,
} from "../../domain/tree-layout-constants";
export const TreeActions = createContext<{
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
type PublicationStatus = "unknown" | "loading" | "published" | "hidden" | "error";

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
  height = treeNodeSize().height,
  isConnectable,
}: NodeProps<PersonNodeType>) {
  const {
    choose,
    selectOnly,
    collapse,
    expand,
    reference,
    publishPerson,
    publicationUpdate,
    relationLabel: getRelationLabel,
  } = useContext(TreeActions);
  const archiveId = archiveContextAt(window.location.pathname)?.id || null;
  const publicationEndpoint = archiveResourceUrl(
    `/api/admin/published-people/${encodeURIComponent(data.person.id)}`,
  );
  const [publicationState, setPublicationState] = useState<{
    endpoint: string;
    status: PublicationStatus;
  }>({ endpoint: "", status: "unknown" });
  const publicationStatus = publicationState.endpoint === publicationEndpoint
    ? publicationState.status : "unknown";
  const publicationRequest = useRef<AbortController | null>(null);
  const lastPublicationCheck = useRef(0);
  useEffect(() => () => {
    publicationRequest.current?.abort();
    publicationRequest.current = null;
  }, [publicationEndpoint]);
  useEffect(() => {
    if (
      publicationUpdate?.personId !== data.person.id ||
      publicationUpdate.archiveId !== archiveId
    ) return;
    publicationRequest.current?.abort();
    publicationRequest.current = null;
    lastPublicationCheck.current = Date.now();
    setPublicationState({
      endpoint: publicationEndpoint,
      status: publicationUpdate.published ? "published" : "hidden",
    });
  }, [publicationUpdate, data.person.id, archiveId, publicationEndpoint]);
  function checkPublication() {
    if (!publishPerson || publicationRequest.current) return;
    if (
      (publicationStatus === "published" || publicationStatus === "hidden") &&
      Date.now() - lastPublicationCheck.current < 30_000
    ) return;
    const controller = new AbortController();
    publicationRequest.current = controller;
    setPublicationState({ endpoint: publicationEndpoint, status: "loading" });
    void archiveFetch(publicationEndpoint, {
      signal: controller.signal,
      cache: "no-store",
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Не удалось проверить доступность");
      if (controller.signal.aborted) return;
      lastPublicationCheck.current = Date.now();
      setPublicationState({
        endpoint: publicationEndpoint,
        status: body.published ? "published" : "hidden",
      });
    }).catch(() => {
      if (!controller.signal.aborted)
        setPublicationState({ endpoint: publicationEndpoint, status: "error" });
    }).finally(() => {
      if (publicationRequest.current === controller) publicationRequest.current = null;
    });
  }
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
  const relationLabel = useMemo(
    () => detail === "distant" ? "" : getRelationLabel(data.person),
    [detail, getRelationLabel, data.person],
  );
  const lifespan = years(data.person);
  const cardLabel = `${fullName(data.person)}${lifespan ? `, ${lifespan}` : ""}${relationLabel ? `, ${relationLabel}` : ""}${data.person.needsReview ? ", требует проверки" : ""}`;
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
          aria-label={`Связать: ${fullName(data.person)}`}
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
        {detail === "distant" ? (
          <span
            className={`person-avatar ${resolvedSex(data.person) === "f" ? "female" : resolvedSex(data.person) === "m" ? "male" : "unknown"}`}
            aria-hidden="true"
          />
        ) : <Avatar person={data.person} loading="eager" />}
        <span className="portrait-card-info">
          <strong>{fullName(data.person)}</strong>
          {lifespan && <span className="portrait-card-years">{lifespan}</span>}
          {relationLabel && <small>{relationLabel}</small>}
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
            : publicationStatus === "loading" ? <LoaderCircle size={18} aria-hidden="true" />
            : <CircleHelp size={18} aria-hidden="true" />}
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
      {!data.familyFocus && data.childrenCount > 0 && (
        <button
          className="flow-collapse nodrag nopan"
          aria-label={branchTitle}
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
