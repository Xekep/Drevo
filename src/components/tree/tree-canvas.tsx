import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  MarkerType,
  Panel,
  useReactFlow,
  useViewport,
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
import {
  RelationshipEdge,
  type RelationshipEdgeType,
} from "./relationship-edge";
import { EraOverlay } from "./era-overlay";
import { routeKey } from "../../domain/edge-routing";

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
  onLink: () => void;
  focus: TreeFocus | null;
  preview: ConnectionDraft | null;
  query: string;
  highlighted: string[];
};
const nodeTypes = { person: PersonNode },
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
  const [collapsed, setCollapsed] = useState(new Set<string>()),
    [root, setRoot] = useState<string | null>(null);
  const flow = useReactFlow<PersonNodeType, RelationshipEdgeType>(),
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
    worker.onmessage = (event: MessageEvent<TreeGeometry>) => {
      layoutPeople.current = family.people;
      clearTimeout(timer);
      setGeometry(event.data);
      setLayoutBusy(false);
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
  const actions = useMemo(
    () => ({ choose: onChoose, collapse: toggleCollapse }),
    [onChoose, toggleCollapse],
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
    () => new Map(geometry?.positions || []),
    [geometry],
  );
  const routes = useMemo(() => new Map(geometry?.routes || []), [geometry]);
  const nodes = useMemo<PersonNodeType[]>(
    () =>
      family.people
        .filter((p) => visible.has(p.id) && positions.has(p.id))
        .map((p) => ({
          id: p.id,
          type: "person",
          position: positions.get(p.id)!,
          width: TREE_NODE_WIDTH,
          height: TREE_NODE_HEIGHT,
          selected: selected.includes(p.id),
          data: {
            person: p,
            collapsed: collapsed.has(p.id),
            childrenCount: childrenCount.get(p.id) || 0,
            dimmed: !matchesPerson(p, props.query),
          },
          draggable: false,
        })),
    [
      family.people,
      visible,
      positions,
      selected,
      collapsed,
      childrenCount,
      props.query,
    ],
  );
  const connections = useMemo(() => archiveConnections(family), [family]);
  const peopleMap = useMemo(
    () => new Map(family.people.map((p) => [p.id, p])),
    [family.people],
  );
  const edges = useMemo<RelationshipEdgeType[]>(
    () =>
      connections
        .filter((e) => visible.has(e.from) && visible.has(e.to))
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
    ],
  );
  const displayEdges = useMemo<RelationshipEdgeType[]>(
    () =>
      props.preview?.from &&
      props.preview.to &&
      props.preview.from !== props.preview.to
        ? [
            ...edges,
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
        : edges,
    [edges, props.preview],
  );
  useEffect(() => {
    if (
      !geometry ||
      !nodes.length ||
      geometry.mode !== mode ||
      geometry.reverse !== reverse ||
      layoutPeople.current !== family.people
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
        else void flow.fitView({ maxZoom: 1, padding: 0.25 });
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
  ]);
  const connect = useCallback(
    (c: FlowConnection) => {
      if (c.source && c.target)
        onConnect({ from: c.source, to: c.target, type: "parent" });
    },
    [onConnect],
  );
  function switchMode(next: TreeMode) {
    cameras.current[mode] = flow.getViewport();
    setMode(next);
  }
  return (
    <TreeActions.Provider value={actions}>
      <div className={`tree-canvas mode-${mode}`}>
        <div className="tree-mode-bar">
          <div className="segmented" aria-label="Представление дерева">
            <button
              aria-pressed={mode === "generations"}
              onClick={() => switchMode("generations")}
            >
              Поколения
            </button>
            <button
              aria-pressed={mode === "timeline"}
              onClick={() => switchMode("timeline")}
            >
              Хронология
            </button>
          </div>
          <span>
            {layoutBusy
              ? "Расставляем карточки…"
              : `${nodes.length} из ${family.people.length} человек`}
          </span>
        </div>
        <ReactFlow<PersonNodeType, RelationshipEdgeType>
          nodes={nodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionMode={ConnectionMode.Loose}
          onConnect={connect}
          onReconnect={(edge, c) => {
            if (edge.data && c.source && c.target)
              onConnect({
                from: c.source,
                to: c.target,
                type: edge.data.connection.type,
                original: edge.data.connection,
                note: edge.data.connection.note,
              });
          }}
          onEdgeClick={(_, e) => {
            if (e.data) onEdge(e.data.connection);
          }}
          onPaneClick={props.onClear}
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
          fitView
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
