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
  type Family,
  type ArchiveUser,
  type GraphConnection,
  type TreeMode,
} from "../../domain";
import { PersonNode, TreeActions, type PersonNodeType } from "./person-node";
import { useTouchZoom } from "../../hooks/useTouchZoom";
import { useCtrlWheelZoom } from "../../hooks/useCtrlWheelZoom";
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
import {
  TREE_LAYOUT_TRANSITION_MS,
  treeGrowthCanvasStyle,
  treeGrowthDelays,
  treeGrowthDuration,
} from "./tree-growth";
import { TreeCreateAt, type TreeCreateAtDraft } from "./tree-create-at";
import { useTreeCameraState } from "./use-tree-camera-state";
import { familySpotlight } from "./family-spotlight";
import { FanChart } from "./fan-chart";
import {
  captureFanMorphSources,
  runFanMorph,
  type FanMorphSource,
} from "./fan-morph";

export type ConnectionDraft = {
  from: string;
  to: string;
  type: GraphConnection["type"];
  original?: GraphConnection;
  note?: string;
  hint?: string;
};
export type TreeFocus = {
  ids: string[];
  token: number;
  purpose?: "family";
  groupId?: string;
};
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
  assistantFilter?: { ids: string[]; label: string; token: number } | null;
  onClearAssistantFilter?: () => void;
  zoomRequest?: { token: number; direction: "in" | "out" };
  preview: ConnectionDraft | null;
  query: string;
  highlighted: string[];
  spotlight?: string[];
  onIntroComplete?: () => void;
};
const nodeTypes = { person: PersonNode, household: HouseholdNode },
  edgeTypes = { relationship: RelationshipEdge };
function Canvas(props: Props) {
  const narrow = useNarrowScreen();
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = container.current;
    const preventTextSelection = (event: Event) => {
      if (
        !(event.target as Element).closest(
          "input, textarea, [contenteditable='true']",
        )
      )
        event.preventDefault();
    };
    node?.addEventListener("selectstart", preventTextSelection);
    return () => node?.removeEventListener("selectstart", preventTextSelection);
  }, []);
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
  const [fanAnchor, setFanAnchor] = useState<string | null>(null);
  const [returnTarget, setReturnTarget] = useState<{
    id: string;
    token: number;
  } | null>(null);
  const returnToken = useRef(0);
  const returnToPerson = useCallback((id?: string | null) => {
    if (!id) return;
    returnToken.current += 1;
    setReturnTarget({ id, token: returnToken.current });
  }, []);
  const clearReturnTarget = useCallback(() => setReturnTarget(null), []);
  const [fanMorphing, setFanMorphing] = useState(false);
  const fanMorphSources = useRef<FanMorphSource[]>([]);
  const activeFanAnchor =
    fanAnchor && family.people.some((person) => person.id === fanAnchor)
      ? fanAnchor
      : null;
  const [growing, setGrowing] = useState(true);
  useEffect(() => {
    if (!activeFanAnchor || !fanMorphing) return;
    const element = container.current;
    const sources = fanMorphSources.current;
    if (!element) {
      setFanMorphing(false);
      return;
    }
    let active = true;
    void runFanMorph(element, sources).finally(() => {
      if (!active) return;
      fanMorphSources.current = [];
      setFanMorphing(false);
    });
    return () => {
      active = false;
    };
  }, [activeFanAnchor, fanMorphing]);
  const [initialCameraReady, setInitialCameraReady] = useState(false);
  const [introCameraFinished, setIntroCameraFinished] = useState(false);
  const markInitialCameraReady = useCallback(
    () => setInitialCameraReady(true),
    [],
  );
  const growthActive = growing && !narrow;
  const introHandled = useRef(false);
  const introComplete = useRef(props.onIntroComplete);
  useEffect(() => {
    introComplete.current = props.onIntroComplete;
  }, [props.onIntroComplete]);
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
  const showAllBranches = familyView.showAll;
  const filterToken = props.assistantFilter?.token;
  useEffect(() => {
    if (filterToken) showAllBranches();
  }, [filterToken, showAllBranches]);
  const { anchor: root, collapsed, toggle: toggleView } = familyView;
  const visible = useMemo(() => {
    if (!props.assistantFilter) return familyView.visible;
    const allowed = new Set(family.people.map((person) => person.id));
    return new Set(props.assistantFilter.ids.filter((id) => allowed.has(id)));
  }, [family.people, familyView.visible, props.assistantFilter]);
  const flow = useReactFlow<
    PersonNodeType | HouseholdNodeType,
    RelationshipEdgeType
  >();
  const lastAssistantZoom = useRef(0);
  const context = props.assistantFilter
    ? `${mode}:research:${props.assistantFilter.token}`
    : `${mode}:${familyView.mode}:${root || "all"}`;
  useTouchZoom(container, flow, !screen.fullscreen && !activeFanAnchor);
  useCtrlWheelZoom(container, flow, !activeFanAnchor);
  const { geometry, ready, problem, layoutBusy, layoutKey } = useTreeLayout(
    family,
    visible,
    mode,
    reverse,
  );
  useEffect(() => {
    const request = props.zoomRequest;
    if (
      !request?.token ||
      request.token === lastAssistantZoom.current ||
      !ready ||
      !initialCameraReady ||
      !introCameraFinished ||
      growing
    ) return;
    lastAssistantZoom.current = request.token;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches ? 0 : 320;
    if (request.direction === "in") void flow.zoomIn({ duration });
    else void flow.zoomOut({ duration });
  }, [flow, props.zoomRequest, ready, initialCameraReady, introCameraFinished, growing]);
  const spotlightNodes = useMemo(
    () =>
      geometry && focus?.purpose === "family" && focus.groupId
        ? familySpotlight(geometry, focus.groupId, focus.ids)
        : null,
    [geometry, focus],
  );
  const cameraFocus = useMemo(
    () =>
      focus?.purpose === "family" && spotlightNodes?.length
        ? { ...focus, ids: spotlightNodes }
        : focus,
    [focus, spotlightNodes],
  );
  const growthDelays = useMemo(
    () => treeGrowthDelays(family.people),
    [family.people],
  );
  const growthCanvasStyle = useMemo(
    () => treeGrowthCanvasStyle(growthDelays),
    [growthDelays],
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
        root: familyView.mode === "family" && !props.assistantFilter ? root : null,
        hidden: familyView.hidden,
        expanded: familyView.expanded,
        query: props.query,
        spotlight: new Set(props.spotlight || []),
        spotlightOccurrences: spotlightNodes
          ? new Set(spotlightNodes)
          : undefined,
        growthDelays,
      }),
    [
      family,
      geometry,
      mode,
      visible,
      selected,
      collapsed,
      root,
      props.assistantFilter,
      familyView.mode,
      familyView.hidden,
      familyView.expanded,
      props.query,
      props.spotlight,
      spotlightNodes,
      growthDelays,
    ],
  );
  const {
    positions,
    occurrencePeople,
    personOccurrences,
    peopleMap,
    nodes,
    displayNodes,
    maxGrowthDelay,
  } = nodeModel;
  useEffect(() => {
    if (!growing || !ready || !nodes.length) return;
    const timer = window.setTimeout(
      () => setGrowing(false),
      narrow ? 0 : treeGrowthDuration(maxGrowthDelay, growthDelays),
    );
    return () => window.clearTimeout(timer);
  }, [growing, ready, nodes.length, maxGrowthDelay, growthDelays, narrow]);
  useEffect(() => {
    if (
      growing ||
      (narrow && !initialCameraReady) ||
      !ready ||
      !nodes.length ||
      introHandled.current
    )
      return;
    introHandled.current = true;
    let active = true;
    const done = () => {
      if (active) {
        setIntroCameraFinished(true);
        introComplete.current?.();
      }
    };
    const personId = user?.personId,
      occurrence = personId ? personOccurrences.get(personId)?.[0] : undefined,
      shouldKeepRequestedFocus = !!focus || selected.length > 0;
    if (
      !occurrence ||
      !positions.has(occurrence) ||
      shouldKeepRequestedFocus ||
      familyView.mode !== "all"
    ) {
      done();
      return () => {
        active = false;
      };
    }
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    void flow
      .fitView({
        nodes: [{ id: occurrence }],
        minZoom: narrow ? 0.72 : 0.55,
        maxZoom: narrow ? 0.96 : 1.08,
        padding: narrow ? 0.75 : 0.9,
        duration: reducedMotion ? 0 : 620,
        ease: (progress) => 1 - (1 - progress) ** 3,
      })
      .then(done, done);
    return () => {
      active = false;
    };
  }, [
    growing,
    initialCameraReady,
    ready,
    nodes.length,
    user?.personId,
    personOccurrences,
    positions,
    focus,
    selected.length,
    familyView.mode,
    flow,
    narrow,
  ]);
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
      focus: cameraFocus,
      returnPersonId: returnTarget?.id || null,
      returnToken: returnTarget?.token || 0,
      personOccurrences,
      onReturnComplete: clearReturnTarget,
      positions,
      selected,
      narrow,
      peopleMap,
      context,
      root,
      onInitialViewReady: markInitialCameraReady,
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
        growthDelays,
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
      growthDelays,
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
    if (activeFanAnchor) returnToPerson(activeFanAnchor);
    setFanAnchor(null);
    setMode(next);
    setEdgeChoices([]);
  }
  return (
    <TreeActions.Provider value={actions}>
      <div
        ref={container}
        className={`tree-canvas mode-${mode} ${activeFanAnchor ? "is-fan" : ""} ${fanMorphing ? "is-fan-morphing" : ""} ${growthActive ? "is-growing" : ""} ${layoutSettling ? "is-layout-settling" : ""} ${screen.fullscreen ? "is-fullscreen" : ""}`}
        style={growthCanvasStyle}
        tabIndex={-1}
        aria-busy={growthActive}
        onContextMenu={(event) => {
          if (growthActive) event.preventDefault();
        }}
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
          {props.assistantFilter && (
            <div className="tree-family-tools" role="status">
              <span className="tree-family-count">
                {props.assistantFilter.label}: {visible.size} из {family.people.length}
              </span>
              <button type="button" onClick={() => {
                props.onClearAssistantFilter?.();
                familyView.showAll();
              }}>Всё древо</button>
            </div>
          )}
          {family.people.length > 0 && !props.restricted && !props.assistantFilter && (
            <FamilyViewTools
              onShare={
                root && props.onShare
                  ? () => props.onShare!(root, [...visible])
                  : undefined
              }
              anchor={activeFanAnchor ? peopleMap.get(activeFanAnchor) : root ? peopleMap.get(root) : undefined}
              selected={peopleMap.get(selected[0])}
              count={visible.size}
              total={family.people.length}
              changed={
                familyView.mode === "family"
                  ? familyView.expanded.size > 0
                  : collapsed.size > 0
              }
              mode={familyView.mode}
              onFamily={() => {
                props.onClearAssistantFilter?.();
                rememberContext();
                clearReturnTarget();
                setFanAnchor(null);
                familyView.enter();
              }}
              onCommon={() => {
                props.onClearAssistantFilter?.();
                rememberContext();
                clearReturnTarget();
                setFanAnchor(null);
                familyView.enterCommon();
              }}
              onFan={() => {
                if (activeFanAnchor) {
                  const target = activeFanAnchor;
                  fanMorphSources.current = [];
                  setFanMorphing(false);
                  setFanAnchor(null);
                  returnToPerson(target);
                  return;
                }
                const next =
                  selected[0] || root || familyView.defaultAnchor;
                if (!next) return;
                const element = container.current;
                const morph = element
                  ? captureFanMorphSources(element, family, next)
                  : [];
                rememberContext();
                clearReturnTarget();
                setGrowing(false);
                setEdgeChoices([]);
                setCreateAt(null);
                fanMorphSources.current = morph;
                setFanMorphing(true);
                setFanAnchor(next);
              }}
              fanActive={!!activeFanAnchor}
              onAll={() => {
                props.onClearAssistantFilter?.();
                const target = activeFanAnchor || root;
                rememberContext();
                setFanAnchor(null);
                familyView.showAll();
                returnToPerson(target);
              }}
              onReset={() => {
                resetContext();
                familyView.reset();
              }}
            />
          )}
        </div>
        {!narrow && props.comparisonAction}
        {activeFanAnchor ? (
          <FanChart
            family={family}
            anchorId={activeFanAnchor}
            selected={selected}
            onChoose={(id) => onChoose(id, false)}
          />
        ) : (
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
          panOnDrag={growthActive ? false : [0, 1]}
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
        )}
        {!activeFanAnchor && (
          <TreeEdgeChoices
          choices={edgeChoices}
          peopleMap={peopleMap}
          connections={connections}
          closeRef={choiceClose}
          onClose={() => setEdgeChoices([])}
          onSelect={onEdge}
        />
        )}
        {!activeFanAnchor && (
          <TreeCreateAt
          draft={props.canEdit ? createAt : null}
          busy={props.busy}
          personName={createAt ? peopleMap.get(createAt.id)?.name : undefined}
          onAdd={props.onAddRelative}
          onClose={() => setCreateAt(null)}
        />
        )}
        {!activeFanAnchor && mode === "timeline" && geometry?.mode === "timeline" && (
          <EraOverlay geometry={geometry} />
        )}
        {!activeFanAnchor && problem && (
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
