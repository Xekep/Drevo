import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  type Connection as FlowConnection,
} from "@xyflow/react";
import { Maximize2, Plus, GitBranch, Link2 } from "lucide-react";
import {
  archiveConnections,
  generationLevels,
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
import { buildTreeNodeModel } from "./tree-node-model";
import { TreeCameraTools } from "./tree-camera-tools";
import { TreeEdgeChoices } from "./tree-edge-choices";
import { TREE_LAYOUT_TRANSITION_MS, treeGrowthDuration } from "./tree-growth";
import { TreeCreateAt, type TreeCreateAtDraft } from "./tree-create-at";
import { useTreeCameraState } from "./use-tree-camera-state";

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
function Canvas(props: Props) {
  const narrow = useNarrowScreen();
  const container = useRef<HTMLDivElement>(null);
  const screen = useTreeFullscreen(container);
  const lastPaneTap = useRef({ time: 0, x: 0, y: 0 });
  const [createAt, setCreateAt] = useState<TreeCreateAtDraft | null>(null);
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
  const [growing, setGrowing] = useState(true);
  const [layoutSettling, setLayoutSettling] = useState(false);
  const settledLayout = useRef("");
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
  >();
  const context = `${mode}:${root || "all"}`;
  useTouchZoom(container, flow, !screen.fullscreen);
  const { geometry, ready, problem, layoutBusy, layoutKey } = useTreeLayout(
    family,
    visible,
    mode,
    reverse,
  );
  const growthLevels = useMemo(
    () => generationLevels(family.people),
    [family.people],
  );
  const nodeModel = useMemo(
    () =>
      buildTreeNodeModel({
        family,
        geometry,
        mode,
        visible,
        selected,
        collapsed,
        root,
        hidden: familyView.hidden,
        expanded: familyView.expanded,
        query: props.query,
        growthLevels,
      }),
    [
      family,
      geometry,
      mode,
      visible,
      selected,
      collapsed,
      root,
      familyView.hidden,
      familyView.expanded,
      props.query,
      growthLevels,
    ],
  );
  const {
    childrenCount,
    positions,
    occurrencePeople,
    personOccurrences,
    peopleMap,
    nodes,
    displayNodes,
    maxGrowthLevel,
  } = nodeModel;
  useEffect(() => {
    if (!growing || !ready || !nodes.length) return;
    const timer = window.setTimeout(
      () => setGrowing(false),
      treeGrowthDuration(maxGrowthLevel),
    );
    return () => window.clearTimeout(timer);
  }, [growing, ready, nodes.length, maxGrowthLevel]);
  useLayoutEffect(() => {
    if (!ready || !geometry) return;
    const previous = settledLayout.current;
    settledLayout.current = layoutKey;
    if (!previous || previous === layoutKey) return;
    setLayoutSettling(true);
    const timer = window.setTimeout(
      () => setLayoutSettling(false),
      TREE_LAYOUT_TRANSITION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [geometry, layoutKey, ready]);
  const { rememberContext, resetContext, rememberViewport } =
    useTreeCameraState({
      flow,
      geometry,
      nodeCount: nodes.length,
      mode,
      reverse,
      ready,
      focus,
      positions,
      selected,
      narrow,
      peopleMap,
      context,
      root,
      familyPeople: family.people,
      childrenCount,
      expanded: familyView.expanded,
      collapsed,
    });
  const toggleBranch = useCallback(
    (id: string) => {
      setGrowing(false);
      toggleView(id);
    },
    [toggleView],
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
        growthLevels,
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
      growthLevels,
    ],
  );
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
    rememberContext();
    setMode(next);
    setEdgeChoices([]);
  }
  return (
    <TreeActions.Provider value={actions}>
      <div
        ref={container}
        className={`tree-canvas mode-${mode} ${growing ? "is-growing" : ""} ${layoutSettling ? "is-layout-settling" : ""} ${screen.fullscreen ? "is-fullscreen" : ""}`}
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
                rememberContext();
                familyView.enter();
              }}
              onAll={() => {
                rememberContext();
                familyView.showAll();
              }}
              onReset={() => {
                resetContext();
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
          onMoveEnd={(_, camera) => rememberViewport(camera)}
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
            <TreeCameraTools selected={selected} />
          )}
        </ReactFlow>
        <TreeEdgeChoices
          choices={edgeChoices}
          peopleMap={peopleMap}
          connections={connections}
          closeRef={choiceClose}
          onClose={() => setEdgeChoices([])}
          onSelect={onEdge}
        />
        <TreeCreateAt
          draft={props.canEdit ? createAt : null}
          busy={props.busy}
          personName={createAt ? peopleMap.get(createAt.id)?.name : undefined}
          onAdd={props.onAddRelative}
          onClose={() => setCreateAt(null)}
        />
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
