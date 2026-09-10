import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  MarkerType,
  Panel,
  useReactFlow,
  useViewport,
  useStore,
  type Viewport,
  type Connection as FlowConnection,
} from "@xyflow/react";
import {
  Focus,
  Maximize2,
  Minus,
  Plus,
  GitBranch,
  X,
  RotateCcw,
  Link2,
} from "lucide-react";
import {
  archiveConnections,
  connectionKey,
  canChangeConnection,
  fullName,
  matchesPerson,
  TREE_NODE_WIDTH,
  TREE_NODE_HEIGHT,
  visibleBranch,
  type Family,
  type ArchiveUser,
  type GraphConnection,
  type TreeMode,
  type TreeGeometry,
} from "../../domain";
import { PersonNode, TreeActions, type PersonNodeType } from "./person-node";
import { HouseholdNode, type HouseholdNodeType } from "./household-node";
import {
  RelationshipEdge,
  type RelationshipEdgeType,
} from "./relationship-edge";
import { EraOverlay } from "./era-overlay";
import { routeKey } from "../../domain/edge-routing";
import { crossingPaths } from "../../domain/route-crossings";
import { useNarrowScreen } from "../../hooks/useNarrowScreen";
import { ArchiveSummary } from "../archive-summary";
import {
  initialFamilyFocus,
  relativeAtHandle,
} from "../../domain/tree-interactions";

export type ConnectionDraft = {
  from: string;
  to: string;
  type: GraphConnection["type"];
  original?: GraphConnection;
  note?: string;
  hint?: string;
};
export type TreeFocus = { ids: string[]; token: number };
type Props = {
  family: Family;
  user: ArchiveUser | null;
  canEdit: boolean;
  busy: boolean;
  reverse: boolean;
  selected: string[];
  selectedEdge?: string;
  onChoose: (id: string, additive?: boolean) => void;
  onEdge: (edge: GraphConnection) => void;
  onConnect: (draft: ConnectionDraft) => void;
  onClear: () => void;
  onAdd: () => void;
  onAddRelative: (id: string, type: "parent" | "child" | "spouse") => void;
  onLink: () => void;
  focus: TreeFocus | null;
  preview: ConnectionDraft | null;
  query: string;
  highlighted: string[];
};
const nodeTypes = { person: PersonNode, household: HouseholdNode },
  edgeTypes = { relationship: RelationshipEdge };
const colors = {
  parent: "#58775a",
  spouse: "#b38167",
  adoptive_parent: "#638fa0",
  godparent: "#9b83ac",
  guardian: "#8d9860",
  nurse: "#a58958",
  sworn_sibling: "#748ca9",
};
const patterns = {
  parent: undefined,
  spouse: "7 4",
  adoptive_parent: "10 4",
  godparent: "2 5",
  guardian: "10 3 2 3",
  nurse: "2 3",
  sworn_sibling: "7 3 2 3",
};
function CameraTools({ selected }: { selected: string[] }) {
  const flow = useReactFlow(),
    { zoom } = useViewport();
  return (
    <Panel position="bottom-center" className="flow-camera-tools">
      <button aria-label="Уменьшить" onClick={() => void flow.zoomOut()}>
        <Minus size={18} />
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button aria-label="Увеличить" onClick={() => void flow.zoomIn()}>
        <Plus size={18} />
      </button>
      <i />
      <button
        title="Показать всё дерево"
        aria-label="Показать всё дерево"
        onClick={() => void flow.fitView({ padding: 0.2, maxZoom: 1 })}
      >
        <Maximize2 size={18} />
      </button>
      <button
        disabled={!selected.length}
        title="К выбранному человеку"
        aria-label="К выбранному человеку"
        onClick={() =>
          void flow.fitView({
            nodes: selected.map((id) => ({ id })),
            maxZoom: 1,
            padding: 0.4,
          })
        }
      >
        <Focus size={18} />
      </button>
    </Panel>
  );
}
function Canvas(props: Props) {
  const narrow = useNarrowScreen();
  const canvasWidth = useStore((s) => s.width),
    canvasHeight = useStore((s) => s.height);
  const container = useRef<HTMLDivElement>(null);
  const mobileCamera = useRef("");
  const [createAt, setCreateAt] = useState<{
    id: string;
    type: "parent" | "child" | "spouse";
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    if (!createAt) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element)?.closest(".tree-create-at"))
        setCreateAt(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreateAt(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [createAt]);
  const {
    family,
    user,
    selected,
    reverse,
    onChoose,
    onEdge,
    onConnect,
    focus,
  } = props;
  const [mode, setMode] = useState<TreeMode>("generations"),
    [geometry, setGeometry] = useState<TreeGeometry | null>(null),
    [problem, setProblem] = useState("");
  const [extraVisible, setExtraVisible] = useState(true);
  const [edgeChoices, setEdgeChoices] = useState<GraphConnection[]>([]);
  const choiceClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!edgeChoices.length) return;
    const previous = document.activeElement;
    choiceClose.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEdgeChoices([]);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [edgeChoices.length]);
  const [collapsed, setCollapsed] = useState(new Set<string>()),
    [root, setRoot] = useState<string | null>(null);
  const flow = useReactFlow<
      PersonNodeType | HouseholdNodeType,
      RelationshipEdgeType
    >(),
    cameras = useRef<Partial<Record<TreeMode, Viewport>>>({}),
    lastFocus = useRef(-1),
    previousMode = useRef<TreeMode>(mode);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const layoutPeople = useRef(family.people),
    previousReverse = useRef(reverse);
  useEffect(() => {
    const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), {
      type: "module",
    });
    const timer = setTimeout(() => setLayoutBusy(true), 80);
    worker.onmessage = (
      event: MessageEvent<TreeGeometry | { error: string }>,
    ) => {
      clearTimeout(timer);
      setLayoutBusy(false);
      if ("error" in event.data) {
        setProblem(event.data.error);
        return;
      }
      layoutPeople.current = family.people;
      setGeometry(event.data);
      setProblem("");
    };
    worker.onerror = () => {
      clearTimeout(timer);
      setLayoutBusy(false);
      setProblem(
        "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.",
      );
    };
    worker.postMessage({
      people: family.people.map(({ id, birth, parents, spouses }) => ({
        id,
        birth,
        parents,
        spouses,
      })),
      links: (family.links || []).map(({ type, from, to }) => ({
        type,
        from,
        to,
      })),
      mode,
      reverse,
    });
    return () => {
      clearTimeout(timer);
      worker.terminate();
    };
  }, [family.people, family.links, mode, reverse]);
  const toggleCollapse = useCallback(
    (id: string) =>
      setCollapsed((value) => {
        const next = new Set(value);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const visible = useMemo(
    () => visibleBranch(family, root, collapsed, selected),
    [family, root, collapsed, selected],
  );
  const childrenCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of family.people)
      for (const parent of p.parents)
        counts.set(parent, (counts.get(parent) || 0) + 1);
    return counts;
  }, [family.people]);
  const positions = useMemo(
    () => new Map(geometry?.mode === mode ? geometry.positions : []),
    [geometry, mode],
  );
  const occurrences = useMemo(
    () =>
      geometry?.mode === mode
        ? geometry.occurrences ||
          family.people.map((p) => ({ id: p.id, personId: p.id, block: "" }))
        : [],
    [geometry, mode, family.people],
  );
  const occurrencePeople = useMemo(
    () => new Map(occurrences.map((o) => [o.id, o.personId])),
    [occurrences],
  );
  const personOccurrences = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const o of occurrences) {
      const list = result.get(o.personId) || [];
      list.push(o.id);
      result.set(o.personId, list);
    }
    return result;
  }, [occurrences]);
  const actions = useMemo(
    () => ({
      choose: (id: string, additive: boolean) => {
        setEdgeChoices([]);
        onChoose(id, additive);
      },
      collapse: toggleCollapse,
      reference: (personId: string, occurrenceId: string) => {
        const ids = personOccurrences.get(personId) || [];
        const next = ids[(ids.indexOf(occurrenceId) + 1) % ids.length];
        if (next)
          void flow.fitView({
            nodes: [{ id: next }],
            maxZoom: 1,
            padding: 0.6,
          });
      },
    }),
    [onChoose, toggleCollapse, personOccurrences, flow],
  );
  const routes = useMemo(() => new Map(geometry?.routes || []), [geometry]);
  const households = useMemo(
    () =>
      geometry?.mode === mode
        ? (geometry.blocks || []).filter((block) =>
            block.members.every((id) => visible.has(occurrencePeople.get(id)!)),
          )
        : [],
    [geometry, mode, occurrencePeople, visible],
  );
  const householdMembers = useMemo(
    () => new Set(households.flatMap((group) => group.members)),
    [households],
  );
  const householdNodes = useMemo<HouseholdNodeType[]>(
    () =>
      households.map((group) => ({
        id: group.id,
        type: "household",
        position: { x: group.x - 8, y: group.y - 8 },
        width: group.width + 16,
        height: group.height + 16,
        data: {},
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        zIndex: -1,
        style: { pointerEvents: "none" },
        domAttributes: { "aria-hidden": true },
      })),
    [households],
  );
  const siblingNodes = useMemo<HouseholdNodeType[]>(
    () =>
      geometry?.mode === mode
        ? (geometry.siblingGroups || [])
            .filter((group) =>
              group.members.every((id) =>
                visible.has(occurrencePeople.get(id)!),
              ),
            )
            .map((group) => ({
              id: group.id,
              type: "household",
              position: { x: group.x, y: group.y },
              width: group.width,
              height: group.height,
              data: {
                label: `Дети · ${group.members.length}`,
                reverse: geometry.reverse,
              },
              draggable: false,
              selectable: false,
              connectable: false,
              focusable: false,
              zIndex: -1,
              style: { pointerEvents: "none" },
              domAttributes: { "aria-hidden": true },
            }))
        : [],
    [geometry, mode, visible, occurrencePeople],
  );
  const peopleMap = useMemo(
    () => new Map(family.people.map((p) => [p.id, p])),
    [family.people],
  );
  const nodes = useMemo<PersonNodeType[]>(
    () =>
      occurrences
        .filter(
          (o) =>
            visible.has(o.personId) &&
            positions.has(o.id) &&
            peopleMap.has(o.personId),
        )
        .map((o) => {
          const p = peopleMap.get(o.personId)!;
          return {
            id: o.id,
            type: "person",
            position: positions.get(o.id)!,
            width: TREE_NODE_WIDTH,
            height: TREE_NODE_HEIGHT,
            selected: selected.includes(p.id),
            data: {
              person: p,
              household: householdMembers.has(o.id),
              occurrences: personOccurrences.get(p.id)?.length || 1,
              collapsed: collapsed.has(p.id),
              childrenCount: childrenCount.get(p.id) || 0,
              dimmed: !matchesPerson(p, props.query),
            },
            draggable: false,
          };
        }),
    [
      occurrences,
      peopleMap,
      personOccurrences,
      visible,
      positions,
      selected,
      collapsed,
      childrenCount,
      props.query,
      householdMembers,
    ],
  );
  const displayNodes = useMemo(
    () => [...householdNodes, ...siblingNodes, ...nodes],
    [householdNodes, siblingNodes, nodes],
  );
  const connections = useMemo(() => archiveConnections(family), [family]);
  const edges = useMemo<RelationshipEdgeType[]>(
    () =>
      connections
        .filter(
          (e) =>
            visible.has(e.from) &&
            visible.has(e.to) &&
            positions.has(e.from) &&
            positions.has(e.to) &&
            (!geometry?.branches ||
              (geometry.coveredRelations
                ? !geometry.coveredRelations.includes(routeKey(e))
                : !["parent", "spouse"].includes(e.type))) &&
            (extraVisible || ["parent", "spouse"].includes(e.type)),
        )
        .map((e) => {
          const a = positions.get(e.from),
            b = positions.get(e.to),
            side = ["spouse", "sworn_sibling"].includes(e.type);
          const route = routes.get(routeKey(e));
          const highlighted = props.highlighted.some(
            (id, i) =>
              i > 0 &&
              ((id === e.to && props.highlighted[i - 1] === e.from) ||
                (id === e.from && props.highlighted[i - 1] === e.to)),
          );
          return {
            id: e.key,
            source: e.from,
            target: e.to,
            type: "relationship",
            sourceHandle:
              route?.sourceHandle ??
              (side
                ? a && b && a.x > b.x
                  ? "left"
                  : "right"
                : a && b && a.y > b.y
                  ? "top"
                  : "bottom"),
            targetHandle:
              route?.targetHandle ??
              (side
                ? a && b && a.x > b.x
                  ? "right"
                  : "left"
                : a && b && a.y > b.y
                  ? "bottom"
                  : "top"),
            selected: props.selectedEdge === e.key,
            data: { connection: e, onSelect: onEdge, route },
            style: {
              stroke: colors[e.type],
              strokeWidth:
                highlighted || props.selectedEdge === e.key ? 3 : 1.6,
              strokeDasharray: patterns[e.type],
            },
            markerEnd: side
              ? undefined
              : {
                  type: MarkerType.ArrowClosed,
                  color: colors[e.type],
                  width: 16,
                  height: 16,
                },
            reconnectable:
              props.canEdit &&
              !props.busy &&
              canChangeConnection(family, user, e, peopleMap),
            focusable: true,
            domAttributes: {
              onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onEdge(e);
                }
              },
            },
            ariaLabel: `${fullName(peopleMap.get(e.from)!)} — ${fullName(peopleMap.get(e.to)!)}`,
          };
        }),
    [
      connections,
      visible,
      positions,
      routes,
      props.highlighted,
      props.selectedEdge,
      props.busy,
      props.canEdit,
      onEdge,
      family,
      user,
      peopleMap,
      geometry,
      extraVisible,
    ],
  );
  const familyEdges = useMemo<RelationshipEdgeType[]>(() => {
    const actual = new Map(connections.map((e) => [e.key, e]));
    return (geometry?.mode === mode ? geometry.branches || [] : [])
      .filter(
        (b) =>
          visible.has(occurrencePeople.get(b.source)!) &&
          visible.has(occurrencePeople.get(b.target)!) &&
          positions.has(b.source) &&
          positions.has(b.target),
      )
      .flatMap((b) => {
        const choices = b.relations
          .filter((r) => visible.has(r.from) && visible.has(r.to))
          .map((r) => actual.get(connectionKey(r)))
          .filter((e): e is GraphConnection => !!e);
        if (!choices.length) return [];
        const e = choices[0];
        const selected = choices.some((c) => c.key === props.selectedEdge);
        const highlighted = choices.some((c) =>
          props.highlighted.some(
            (id, i) =>
              i > 0 &&
              ((id === c.to && props.highlighted[i - 1] === c.from) ||
                (id === c.from && props.highlighted[i - 1] === c.to)),
          ),
        );
        const select = () =>
          choices.length === 1 ? onEdge(e) : setEdgeChoices(choices);
        return [
          {
            id: b.id,
            source: b.source,
            target: b.target,
            type: "relationship",
            sourceHandle: b.route.sourceHandle,
            targetHandle: b.route.targetHandle,
            selected,
            data: {
              connection: e,
              onSelect: select,
              route: b.route,
              junction:
                b.id.startsWith("child:") && b.relations.length > 1
                  ? b.route.points[0]
                  : undefined,
            },
            style: {
              stroke: e.type === "spouse" ? colors.spouse : colors.parent,
              strokeWidth: selected || highlighted ? 2.8 : 1.6,
            },
            reconnectable: false,
            focusable: true,
            ariaLabel: choices
              .map(
                (c) =>
                  `${fullName(peopleMap.get(c.from)!)} — ${fullName(peopleMap.get(c.to)!)}`,
              )
              .join("; "),
            domAttributes: {
              onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select();
                }
              },
            },
          },
        ];
      });
  }, [
    geometry,
    mode,
    connections,
    visible,
    positions,
    occurrencePeople,
    props.selectedEdge,
    props.highlighted,
    onEdge,
    peopleMap,
  ]);
  const allEdges = useMemo(() => {
    const combined = [...familyEdges, ...edges];
    const groups = new Map(
      (geometry?.branches || []).map((b) => [b.id, b.union]),
    );
    const paths = crossingPaths(
      combined.map((e) => ({
        id: e.id,
        group: groups.get(e.id) || e.id,
        route: e.data?.route,
      })),
    );
    return combined.map((e) =>
      paths.has(e.id)
        ? { ...e, data: { ...e.data!, path: paths.get(e.id) } }
        : e,
    );
  }, [familyEdges, edges, geometry]);
  const displayEdges = useMemo<RelationshipEdgeType[]>(
    () =>
      props.preview?.from &&
      props.preview.to &&
      props.preview.from !== props.preview.to
        ? [
            ...allEdges,
            {
              id: "draft-preview",
              source: props.preview.from,
              target: props.preview.to,
              sourceHandle: "bottom",
              targetHandle: "top",
              type: "smoothstep",
              label: "Предпросмотр",
              style: {
                stroke: "#527d67",
                strokeWidth: 3,
                strokeDasharray: "5 5",
              },
              reconnectable: false,
            },
          ]
        : allEdges,
    [allEdges, props.preview],
  );
  useEffect(() => {
    if (
      !geometry ||
      !nodes.length ||
      geometry.mode !== mode ||
      geometry.reverse !== reverse ||
      layoutPeople.current !== family.people ||
      !canvasWidth ||
      !canvasHeight
    )
      return;
    const timer = setTimeout(() => {
      if (
        focus &&
        focus.token !== lastFocus.current &&
        focus.ids.every((id) => positions.has(id))
      ) {
        lastFocus.current = focus.token;
        void flow.fitView({
          nodes: focus.ids.map((id) => ({ id })),
          maxZoom: 1,
          minZoom: narrow ? 0.55 : 0.15,
          padding: 0.5,
        });
      } else if (
        previousMode.current !== mode ||
        previousReverse.current !== reverse
      ) {
        previousMode.current = mode;
        previousReverse.current = reverse;
        if (selected.length)
          void flow.fitView({
            nodes: selected.map((id) => ({ id })),
            maxZoom: 1,
            padding: 0.5,
          });
        else if (cameras.current[mode])
          void flow.setViewport(cameras.current[mode]!);
        else
          void flow.fitView({
            maxZoom: 1,
            minZoom: narrow ? 0.55 : 0.15,
            padding: 0.25,
          });
      } else if (narrow) {
        const key = `${selected.join(":")}:${canvasWidth}:${canvasHeight}`;
        if (mobileCamera.current !== key) {
          const first = !mobileCamera.current;
          mobileCamera.current = key;
          if (!selected.length && !first) return;
          const ids = selected.length
            ? selected
            : initialFamilyFocus(family.people);
          void flow.fitView({
            nodes: ids.map((id) => ({ id })),
            minZoom: 0.55,
            maxZoom: selected.length
              ? Math.max(0.65, Math.min(0.9, flow.getZoom()))
              : 0.8,
            padding: 0.18,
          });
        }
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [
    geometry,
    nodes.length,
    mode,
    reverse,
    family.people,
    focus,
    positions,
    selected,
    flow,
    narrow,
    canvasWidth,
    canvasHeight,
    childrenCount,
    peopleMap,
  ]);
  const connect = useCallback(
    (c: FlowConnection) => {
      if (c.source && c.target)
        onConnect({
          from: occurrencePeople.get(c.source) || c.source,
          to: occurrencePeople.get(c.target) || c.target,
          type: "parent",
        });
    },
    [onConnect, occurrencePeople],
  );
  function switchMode(next: TreeMode) {
    cameras.current[mode] = flow.getViewport();
    setMode(next);
    setEdgeChoices([]);
  }
  return (
    <TreeActions.Provider value={actions}>
      <div ref={container} className={`tree-canvas mode-${mode}`}>
        <div className="tree-mode-bar">
          <div className="segmented" aria-label="Представление дерева">
            <button
              aria-pressed={mode === "generations"}
              onClick={() => switchMode("generations")}
            >
              Древо
            </button>
            <button
              aria-pressed={mode === "timeline"}
              onClick={() => switchMode("timeline")}
            >
              Хронология
            </button>
          </div>
          <ArchiveSummary people={family.people} busy={layoutBusy} />
          {!!family.links?.length && (
            <button
              className="tree-extra-toggle"
              aria-pressed={extraVisible}
              onClick={() => setExtraVisible((v) => !v)}
              title="Крёстные, усыновление, опека и другие дополнительные связи"
            >
              Доп. связи
            </button>
          )}
        </div>
        <ReactFlow<PersonNodeType | HouseholdNodeType, RelationshipEdgeType>
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionMode={ConnectionMode.Loose}
          onConnect={connect}
          onConnectEnd={(event, state) => {
            if (
              !props.canEdit ||
              props.busy ||
              state.isValid ||
              !state.fromNode ||
              state.toNode ||
              !(event.target as Element)?.closest(".react-flow__pane")
            )
              return;
            const point =
              "changedTouches" in event ? event.changedTouches[0] : event;
            const box = container.current?.getBoundingClientRect();
            if (!box || !point) return;
            const handle = state.fromHandle?.id;
            setCreateAt({
              id: occurrencePeople.get(state.fromNode.id) || state.fromNode.id,
              type: relativeAtHandle(handle, reverse),
              x: Math.max(
                10,
                Math.min(box.width - 240, point.clientX - box.left),
              ),
              y: Math.max(
                65,
                Math.min(box.height - 85, point.clientY - box.top),
              ),
            });
          }}
          onReconnect={(edge, c) => {
            if (edge.data && c.source && c.target)
              onConnect({
                from: occurrencePeople.get(c.source) || c.source,
                to: occurrencePeople.get(c.target) || c.target,
                type: edge.data.connection.type,
                original: edge.data.connection,
                note: edge.data.connection.note,
              });
          }}
          onEdgeClick={(_, e) => {
            if (e.data) e.data.onSelect(e.data.connection);
          }}
          onPaneClick={() => {
            setEdgeChoices([]);
            props.onClear();
          }}
          nodesDraggable={false}
          nodesConnectable={props.canEdit && !props.busy}
          nodesFocusable={false}
          edgesReconnectable={props.canEdit && !props.busy}
          deleteKeyCode={null}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          selectionOnDrag={false}
          panOnDrag={[0, 1]}
          minZoom={0.15}
          maxZoom={1.8}
          onlyRenderVisibleElements
          fitView={!narrow}
          fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
          ariaLabelConfig={{
            "controls.zoomIn.ariaLabel": "Увеличить",
            "controls.zoomOut.ariaLabel": "Уменьшить",
            "controls.fitView.ariaLabel": "Показать дерево",
            "edge.a11yDescription.default":
              "Нажмите Enter для выбора связи. Изменить участников можно в правой панели.",
          }}
          onMoveEnd={(_, camera) => {
            cameras.current[mode] = camera;
          }}
        >
          {(selected.length > 0 || root || collapsed.size > 0) && (
            <Panel position="top-right" className="flow-branch-tools">
              <button
                disabled={!selected.length}
                onClick={() => setRoot(selected[0])}
                title="Оставить предков и потомков выбранного человека"
              >
                <GitBranch size={17} />
                Ветка
              </button>
              {root && (
                <button onClick={() => setRoot(null)}>
                  <X size={16} />
                  Всё древо
                </button>
              )}
              {collapsed.size > 0 && (
                <button onClick={() => setCollapsed(new Set())}>
                  <RotateCcw size={16} />
                  Развернуть
                </button>
              )}
            </Panel>
          )}
          {props.canEdit && (
            <Panel position="bottom-left" className="flow-add-tools">
              <button onClick={props.onAdd}>
                <Plus size={18} />
                Человек
              </button>
              <button
                onClick={props.onLink}
                title="Связать последовательным выбором двух карточек"
              >
                <Link2 size={18} />
                Связь
              </button>
            </Panel>
          )}
          <CameraTools selected={selected} />
        </ReactFlow>
        {edgeChoices.length > 0 && (
          <div
            className="tree-edge-choices"
            role="dialog"
            aria-label="Связи семейной ветки"
          >
            <div>
              <strong>Связи этой ветки</strong>
              <button
                aria-label="Закрыть выбор связи"
                ref={choiceClose}
                onClick={() => setEdgeChoices([])}
              >
                <X size={18} />
              </button>
            </div>
            <p>Выберите связь, чтобы открыть её сведения.</p>
            {edgeChoices
              .filter(
                (e) =>
                  peopleMap.has(e.from) &&
                  peopleMap.has(e.to) &&
                  connections.some((c) => c.key === e.key),
              )
              .map((e) => (
                <button
                  key={e.key}
                  onClick={() => {
                    setEdgeChoices([]);
                    onEdge(e);
                  }}
                >
                  <span>{fullName(peopleMap.get(e.from)!)}</span>
                  <small>Родитель → {fullName(peopleMap.get(e.to)!)}</small>
                </button>
              ))}
          </div>
        )}
        {createAt && props.canEdit && (
          <div
            className="tree-create-at"
            style={{ left: createAt.x, top: createAt.y }}
          >
            <button
              disabled={props.busy}
              onClick={() => {
                props.onAddRelative(createAt.id, createAt.type);
                setCreateAt(null);
              }}
            >
              <Plus size={20} />
              <span>
                Добавить{" "}
                {createAt.type === "parent"
                  ? "родителя"
                  : createAt.type === "child"
                    ? "ребёнка"
                    : "супруга / супругу"}
                <small>Связь с {peopleMap.get(createAt.id)?.name}</small>
              </span>
            </button>
          </div>
        )}
        {mode === "timeline" && geometry?.mode === "timeline" && (
          <EraOverlay geometry={geometry} />
        )}
        {problem && (
          <div className="tree-notice" role="alert">
            {problem}
          </div>
        )}
        {!family.people.length && (
          <div className="flow-empty">
            <GitBranch size={48} strokeWidth={1} />
            <h1>С чего начинается ваша история?</h1>
            <p>Добавьте человека, а затем его родителей, детей и близких.</p>
            {props.canEdit && (
              <button className="primary-action" onClick={props.onAdd}>
                <Plus size={18} />
                Добавить первого человека
              </button>
            )}
          </div>
        )}
      </div>
    </TreeActions.Provider>
  );
}
export const TreeCanvas = memo(function TreeCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
});
