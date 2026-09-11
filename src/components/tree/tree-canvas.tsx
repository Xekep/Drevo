import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
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
  Link2,
} from "lucide-react";
import {
  archiveConnections,
  fullName,
  matchesPerson,
  TREE_NODE_WIDTH,
  TREE_NODE_HEIGHT,
  type Family,
  type ArchiveUser,
  type GraphConnection,
  type TreeMode,
} from "../../domain";
import { PersonNode, TreeActions, type PersonNodeType } from "./person-node";
import { useTouchZoom } from "../../hooks/useTouchZoom";
import { HouseholdNode, type HouseholdNodeType } from "./household-node";
import {
  RelationshipEdge,
  type RelationshipEdgeType,
} from "./relationship-edge";
import { EraOverlay } from "./era-overlay";
import { useNarrowScreen } from "../../hooks/useNarrowScreen";
import { useFamilyView } from "./use-family-view";
import { useTreeLayout } from "./use-tree-layout";
import { FamilyViewTools } from "./family-view-tools";
import "../../styles/family-view.css";
import { useTreeFullscreen } from "./use-tree-fullscreen";
import { ArchiveSummary } from "../archive-summary";
import { relativeAtHandle } from "../../domain/tree-interactions";
import { buildTreeEdges } from "./tree-edge-adapter";

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
  comparisonAction?: ReactNode;
  restricted?: boolean;
  onShare?: (anchorId: string, personIds: string[]) => void;
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
        title="Вписать видимую часть дерева"
        aria-label="Вписать видимую часть дерева"
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
  const screen = useTreeFullscreen(container);
  const lastPaneTap = useRef({ time: 0, x: 0, y: 0 });
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
  const [mode, setMode] = useState<TreeMode>("generations");
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
  const familyView = useFamilyView(
    family,
    selected,
    props.highlighted,
    focus,
    props.preview,
  );
  const { anchor: root, visible, collapsed, toggle: toggleView } = familyView;
  const flow = useReactFlow<
      PersonNodeType | HouseholdNodeType,
      RelationshipEdgeType
    >(),
    cameras = useRef<Record<string, Viewport>>({}),
    lastFocus = useRef(-1),
    previousContext = useRef(""),
    previousReverse = useRef(reverse);
  const context = `${mode}:${root || "all"}`;
  useTouchZoom(container, flow, !screen.fullscreen);
  const { geometry, ready, problem, layoutBusy, layoutKey } = useTreeLayout(
    family,
    visible,
    mode,
    reverse,
  );
  const pendingAnchor = useRef<{
    id: string;
    personId: string;
    layoutKey: string;
    x: number;
    y: number;
    zoom: number;
  } | null>(null);
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
  const toggleBranch = useCallback(
    (id: string, occurrenceId?: string) => {
      const point = positions.get(occurrenceId || id);
      if (point) {
        const camera = flow.getViewport();
        pendingAnchor.current = {
          id: occurrenceId || id,
          personId: id,
          layoutKey,
          x: point.x * camera.zoom + camera.x,
          y: point.y * camera.zoom + camera.y,
          zoom: camera.zoom,
        };
      }
      toggleView(id);
    },
    [positions, flow, toggleView, layoutKey],
  );
  const actions = useMemo(
    () => ({
      choose: (id: string, additive: boolean) => {
        setEdgeChoices([]);
        onChoose(id, additive);
      },
      collapse: toggleBranch,
      expand: toggleBranch,
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
    [onChoose, toggleBranch, personOccurrences, flow],
  );
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
              familyFocus: !!root,
              anchor: p.id === root,
              hiddenRelatives: familyView.hidden.get(p.id) || 0,
              expanded: familyView.expanded.has(p.id),
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
      root,
      familyView.hidden,
      familyView.expanded,
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
  const displayEdges = useMemo<RelationshipEdgeType[]>(
    () =>
      buildTreeEdges({
        family,
        user,
        mode,
        geometry,
        connections,
        visible,
        positions,
        occurrencePeople,
        peopleMap,
        highlighted: props.highlighted,
        selectedEdge: props.selectedEdge,
        canEdit: props.canEdit,
        busy: props.busy,
        extraVisible,
        preview: props.preview,
        onEdge,
        onChoices: setEdgeChoices,
      }),
    [
      family,
      user,
      mode,
      geometry,
      connections,
      visible,
      positions,
      occurrencePeople,
      peopleMap,
      props.highlighted,
      props.selectedEdge,
      props.canEdit,
      props.busy,
      extraVisible,
      props.preview,
      onEdge,
    ],
  );
  useEffect(() => {
    if (
      !geometry ||
      !nodes.length ||
      geometry.mode !== mode ||
      geometry.reverse !== reverse ||
      !ready ||
      !canvasWidth ||
      !canvasHeight
    )
      return;
    const timer = setTimeout(() => {
      const changedContext = previousContext.current !== context;
      const switchedMode =
        !!previousContext.current &&
        previousContext.current.split(":")[0] !== mode;
      const reverseChanged = previousReverse.current !== reverse;
      previousContext.current = context;
      previousReverse.current = reverse;
      const anchor = pendingAnchor.current;
      pendingAnchor.current = null;
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
        anchor &&
        anchor.layoutKey !== layoutKey &&
        !changedContext &&
        (positions.has(anchor.id) || positions.has(anchor.personId))
      ) {
        const point = (positions.get(anchor.id) ||
          positions.get(anchor.personId))!;
        void flow.setViewport({
          x: anchor.x - point.x * anchor.zoom,
          y: anchor.y - point.y * anchor.zoom,
          zoom: anchor.zoom,
        });
      } else if (changedContext || reverseChanged) {
        if ((switchedMode || reverseChanged) && selected.length)
          void flow.fitView({
            nodes: selected.map((id) => ({ id })),
            maxZoom: 1,
            minZoom: narrow ? 0.55 : 0.15,
            padding: 0.4,
          });
        else if (root)
          void flow.fitView({
            nodes: narrow
              ? [root, ...(peopleMap.get(root)?.spouses || [])]
                  .filter((id) => positions.has(id))
                  .map((id) => ({ id }))
              : undefined,
            maxZoom: 0.95,
            minZoom: narrow ? 0.55 : 0.25,
            padding: 0.28,
          });
        else if (cameras.current[context] && !reverseChanged)
          void flow.setViewport(cameras.current[context]);
        else
          void flow.fitView({
            maxZoom: 1,
            minZoom: 0.05,
            padding: 0.25,
          });
      } else if (narrow) {
        const key = `${selected.join(":")}:${canvasWidth}:${canvasHeight}`;
        if (mobileCamera.current !== key) {
          mobileCamera.current = key;
          if (!selected.length) return;
          void flow.fitView({
            nodes: selected.map((id) => ({ id })),
            minZoom: 0.55,
            maxZoom: Math.max(0.65, Math.min(0.9, flow.getZoom())),
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
    ready,
    layoutKey,
    context,
    root,
    familyView.expanded,
    collapsed,
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
    cameras.current[context] = flow.getViewport();
    pendingAnchor.current = null;
    setMode(next);
    setEdgeChoices([]);
  }
  return (
    <TreeActions.Provider value={actions}>
      <div
        ref={container}
        className={`tree-canvas mode-${mode} ${screen.fullscreen ? "is-fullscreen" : ""}`}
        tabIndex={-1}
        aria-label="Полотно древа. Для выхода из полного экрана дважды коснитесь фона или нажмите Назад."
      >
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
          {!narrow && (
            <ArchiveSummary people={family.people} busy={layoutBusy} />
          )}
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
          {narrow && props.comparisonAction}
          {family.people.length > 0 && !props.restricted && (
            <FamilyViewTools
              onShare={
                root && props.onShare
                  ? () => props.onShare!(root, [...visible])
                  : undefined
              }
              anchor={root ? peopleMap.get(root) : undefined}
              selected={peopleMap.get(selected[0])}
              count={visible.size}
              total={family.people.length}
              changed={root ? familyView.expanded.size > 0 : collapsed.size > 0}
              onFamily={() => {
                cameras.current[context] = flow.getViewport();
                pendingAnchor.current = null;
                familyView.enter();
              }}
              onAll={() => {
                cameras.current[context] = flow.getViewport();
                pendingAnchor.current = null;
                familyView.showAll();
              }}
              onReset={() => {
                previousContext.current = "";
                pendingAnchor.current = null;
                familyView.reset();
              }}
            />
          )}
        </div>
        {!narrow && props.comparisonAction}
        <ReactFlow<PersonNodeType | HouseholdNodeType, RelationshipEdgeType>
          proOptions={{ hideAttribution: true }}
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
          onPaneClick={(event) => {
            if (screen.fullscreen) {
              const now = performance.now();
              const last = lastPaneTap.current;
              if (
                now - last.time < 350 &&
                Math.hypot(event.clientX - last.x, event.clientY - last.y) < 30
              ) {
                screen.exit();
                lastPaneTap.current = { time: 0, x: 0, y: 0 };
              } else
                lastPaneTap.current = {
                  time: now,
                  x: event.clientX,
                  y: event.clientY,
                };
              return;
            }
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
          zoomOnDoubleClick={!screen.fullscreen}
          selectionOnDrag={false}
          panOnDrag={[0, 1]}
          minZoom={0.05}
          maxZoom={1.8}
          onlyRenderVisibleElements
          fitView={false}
          fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
          ariaLabelConfig={{
            "controls.zoomIn.ariaLabel": "Увеличить",
            "controls.zoomOut.ariaLabel": "Уменьшить",
            "controls.fitView.ariaLabel": "Показать дерево",
            "edge.a11yDescription.default":
              "Нажмите Enter для выбора связи. Изменить участников можно в правой панели.",
          }}
          onMoveEnd={(_, camera) => {
            cameras.current[context] = camera;
          }}
        >
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
          {narrow ? (
            <Panel position="bottom-right" className="flow-fullscreen-tools">
              <button
                onClick={screen.enter}
                aria-label="Развернуть на весь экран"
                title="На весь экран · выход двойным тапом по фону или кнопкой Назад"
              >
                <Maximize2 size={20} />
              </button>
            </Panel>
          ) : (
            <CameraTools selected={selected} />
          )}
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
