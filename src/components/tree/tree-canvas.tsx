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
  type Viewport,
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
import { HorizontalTimeline } from "./horizontal-timeline";
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
import { runFanReveal } from "./fan-reveal";
import { useTreeGrowthInputLock } from "./use-tree-growth-input-lock";

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
  const layoutMode: TreeMode = mode === "timeline" ? "generations" : mode;
  const [fanAnchor, setFanAnchor] = useState<string | null>(null);
  const fanEntry = useRef<{
    anchorId: string;
    mode: TreeMode;
    familyMode: "all" | "family" | "common";
    viewport: Viewport;
  } | null>(null);
  const [restoreViewport, setRestoreViewport] = useState<{
    viewport: Viewport;
    token: number;
  } | null>(null);
  const restoreToken = useRef(0);
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
  const clearRestoreViewport = useCallback(() => setRestoreViewport(null), []);
  const [fanRevealing, setFanRevealing] = useState(false);
  const activeFanAnchor =
    fanAnchor && family.people.some((person) => person.id === fanAnchor)
      ? fanAnchor
      : null;
  const lastFanNavigationFocus = useRef(focus?.token || -1);
  useEffect(() => {
    if (!focus || focus.purpose === "family" || focus.ids.length !== 1) return;
    if (!activeFanAnchor) {
      lastFanNavigationFocus.current = focus.token;
      return;
    }
    if (focus.token === lastFanNavigationFocus.current) return;
    lastFanNavigationFocus.current = focus.token;
    const next = focus.ids[0];
    if (!family.people.some((person) => person.id === next)) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setFanRevealing(false);
      setFanAnchor(next);
    });
    return () => {
      active = false;
    };
  }, [activeFanAnchor, family.people, focus]);
  const [growing, setGrowing] = useState(true);
  useEffect(() => {
    if (!activeFanAnchor || !fanRevealing) return;
    const element = container.current;
    if (!element) {
      setFanRevealing(false);
      return;
    }
    let active = true;
    void runFanReveal(element).finally(() => {
      if (!active) return;
      setFanRevealing(false);
    });
    return () => {
      active = false;
    };
  }, [activeFanAnchor, fanRevealing]);
  const [initialCameraReady, setInitialCameraReady] = useState(false);
  const [manualCameraOverride, setManualCameraOverride] = useState(false);
  const [introCameraFinished, setIntroCameraFinished] = useState(false);
  const [growthStarted, setGrowthStarted] = useState(false);
  const [growthRevealed, setGrowthRevealed] = useState(false);
  const markInitialCameraReady = useCallback(
    () => setInitialCameraReady(true),
    [],
  );
  const growthPreparing = growing && !narrow && family.people.length > 0 && !growthRevealed;
  const growthActive = growing && !narrow && growthStarted;
  const growthLocked = growthPreparing || growthActive;
  useTreeGrowthInputLock(container, growthLocked);
  useEffect(() => {
    if (!growthActive || growthRevealed) return;
    // Let the browser apply the first animation frame while the viewport is
    // still hidden. Revealing it in the same frame can briefly paint cards at
    // their final positions before delayed animations take effect.
    const frame = requestAnimationFrame(() => setGrowthRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, [growthActive, growthRevealed]);
  const introHandled = useRef(false);
  const introComplete = useRef(props.onIntroComplete);
  useEffect(() => {
    introComplete.current = props.onIntroComplete;
  }, [props.onIntroComplete]);
  const [layoutSettling, setLayoutSettling] = useState(false);
  const settledLayout = useRef("");
  const settledNodes = useRef<Array<PersonNodeType | HouseholdNodeType>>([]);
  const settledEdges = useRef<RelationshipEdgeType[]>([]);
  const layoutTimer = useRef<number | null>(null);
  const [layoutTransition, setLayoutTransition] = useState<{
    enteringNodes: ReadonlySet<string>;
    exitingNodes: Array<PersonNodeType | HouseholdNodeType>;
    exitingEdges: RelationshipEdgeType[];
  } | null>(null);
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
    return new Set(
      props.assistantFilter.ids.filter((id) => familyView.visible.has(id)),
    );
  }, [familyView.visible, props.assistantFilter]);
  const timelinePeople = useMemo(
    () => family.people.filter((person) => visible.has(person.id)),
    [family.people, visible],
  );
  const flow = useReactFlow<
    PersonNodeType | HouseholdNodeType,
    RelationshipEdgeType
  >();
  const lastAssistantZoom = useRef(0);
  const context = props.assistantFilter
    ? `${mode}:research:${props.assistantFilter.token}`
    : `${mode}:${familyView.mode}:${root || "all"}`;
  useTouchZoom(container, flow, !growthLocked && !screen.fullscreen && !activeFanAnchor && mode !== "timeline");
  useCtrlWheelZoom(container, flow, !growthLocked && !activeFanAnchor && mode !== "timeline");
  const { geometry, renderVisible, ready, problem, layoutBusy, layoutKey } =
    useTreeLayout(family, visible, layoutMode, reverse);
  useEffect(() => {
    const request = props.zoomRequest;
    if (
      !request?.token ||
      request.token === lastAssistantZoom.current ||
      !ready ||
      !initialCameraReady ||
      !introCameraFinished ||
      growing
    )
      return;
    lastAssistantZoom.current = request.token;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches
      ? 0
      : 320;
    if (request.direction === "in") void flow.zoomIn({ duration });
    else void flow.zoomOut({ duration });
  }, [
    flow,
    props.zoomRequest,
    ready,
    initialCameraReady,
    introCameraFinished,
    growing,
  ]);
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
        mode: layoutMode,
        visible: renderVisible,
        selected,
        collapsed,
        root:
          familyView.mode === "family" && !props.assistantFilter ? root : null,
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
      layoutMode,
      renderVisible,
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
    if (problem) {
      const timer = window.setTimeout(() => setGrowing(false), 0);
      return () => window.clearTimeout(timer);
    }
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (
      !growing ||
      !ready ||
      !nodes.length ||
      (!narrow && !growthStarted && !reduced)
    )
      return;
    const timer = window.setTimeout(
      () => setGrowing(false),
      narrow || reduced ? 0 : treeGrowthDuration(maxGrowthDelay, growthDelays),
    );
    return () => window.clearTimeout(timer);
  }, [
    growing,
    ready,
    nodes.length,
    maxGrowthDelay,
    growthDelays,
    narrow,
    growthStarted,
    problem,
  ]);
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
    void flow
      .fitView({
        nodes: [{ id: occurrence }],
        minZoom: narrow ? 0.72 : 0.55,
        maxZoom: narrow ? 0.96 : 1.08,
        padding: narrow ? 0.75 : 0.9,
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 620,
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
  const { rememberContext, resetContext, rememberViewport } =
    useTreeCameraState({
      flow,
      geometry,
      nodeCount: nodes.length,
      mode: layoutMode,
      reverse,
      ready,
      focusReady: !growing && introCameraFinished,
      focus: cameraFocus,
      returnPersonId: returnTarget?.id || null,
      returnToken: returnTarget?.token || 0,
      restoreViewport,
      onRestoreComplete: clearRestoreViewport,
      personOccurrences,
      onReturnComplete: clearReturnTarget,
      positions,
      selected,
      narrow,
      peopleMap,
      context,
      root,
      onInitialViewReady: markInitialCameraReady,
      manualCameraOverride,
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
        setManualCameraOverride(true);
        void flow.setViewport(flow.getViewport(), { duration: 0 });
        if (!introCameraFinished) setIntroCameraFinished(true);
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
    [
      onChoose,
      toggleBranch,
      personOccurrences,
      flow,
      introCameraFinished,
    ],
  );
  const connections = useMemo(() => archiveConnections(family), [family]);
  const displayEdges = useMemo<RelationshipEdgeType[]>(
    () =>
      buildTreeEdges({
        family,
        user,
        mode: layoutMode,
        geometry,
        connections,
        visible: renderVisible,
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
      layoutMode,
      geometry,
      connections,
      renderVisible,
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
  useLayoutEffect(() => {
    if (!ready || !geometry) return;
    const previous = settledLayout.current;
    const oldNodes = settledNodes.current;
    const oldEdges = settledEdges.current;
    settledLayout.current = layoutKey;
    settledNodes.current = displayNodes;
    settledEdges.current = displayEdges;
    if (!previous || previous === layoutKey) return;
    const nodeIds = new Set(displayNodes.map((node) => node.id));
    const edgeIds = new Set(displayEdges.map((edge) => edge.id));
    const previousIds = new Set(oldNodes.map((node) => node.id));
    setLayoutTransition({
      enteringNodes: new Set(
        displayNodes
          .filter((node) => !previousIds.has(node.id))
          .map((node) => node.id),
      ),
      exitingNodes: oldNodes.filter((node) => !nodeIds.has(node.id)),
      exitingEdges: oldEdges.filter((edge) => !edgeIds.has(edge.id)),
    });
    setLayoutSettling(true);
    if (layoutTimer.current !== null) window.clearTimeout(layoutTimer.current);
    layoutTimer.current = window.setTimeout(() => {
      setLayoutTransition(null);
      setLayoutSettling(false);
      layoutTimer.current = null;
    }, TREE_LAYOUT_TRANSITION_MS);
  }, [geometry, layoutKey, ready, displayNodes, displayEdges]);
  useEffect(
    () => () => {
      if (layoutTimer.current !== null)
        window.clearTimeout(layoutTimer.current);
    },
    [],
  );
  const renderedNodes = useMemo(
    () =>
      layoutTransition
        ? [
            ...displayNodes.map((node) =>
              layoutTransition.enteringNodes.has(node.id)
                ? {
                    ...node,
                    className: `${node.className || ""} tree-enter-node`,
                  }
                : node,
            ),
            ...layoutTransition.exitingNodes.map((node) => ({
              ...node,
              className: `${node.className || ""} tree-exit-node`,
              style: { ...node.style, pointerEvents: "none" as const },
              selectable: false,
              focusable: false,
            })),
          ]
        : displayNodes,
    [displayNodes, layoutTransition],
  );
  const renderedEdges = useMemo(
    () =>
      layoutTransition
        ? [
            ...displayEdges,
            ...layoutTransition.exitingEdges.map((edge) => ({
              ...edge,
              className: `${edge.className || ""} tree-exit-edge`,
              selectable: false,
              focusable: false,
            })),
          ]
        : displayEdges,
    [displayEdges, layoutTransition],
  );
  useEffect(() => {
    if (!growing || narrow || !ready || !initialCameraReady || growthStarted)
      return;
    let frame = 0;
    let attempts = 0;
    const startWhenMounted = () => {
      const element = container.current;
      if (!element) return;
      const mountedNodes = element.querySelectorAll(".react-flow__node").length;
      const mountedEdges = element.querySelectorAll(".react-flow__edge").length;
      // React Flow measures nodes before rendering their edges. Give both a
      // shared animation start, or a late edge may follow its descendant card.
      const mounted =
        displayNodes.length <= 500
          ? mountedNodes >= displayNodes.length &&
            mountedEdges >= displayEdges.length
          : attempts >= 2 &&
            mountedNodes > 0 &&
            (!displayEdges.length || mountedEdges > 0);
      if (mounted) {
        setGrowthStarted(true);
      } else if (++attempts < 30) {
        frame = requestAnimationFrame(startWhenMounted);
      } else {
        setGrowthStarted(true);
      }
    };
    frame = requestAnimationFrame(startWhenMounted);
    return () => cancelAnimationFrame(frame);
  }, [
    growing,
    narrow,
    ready,
    initialCameraReady,
    growthStarted,
    displayNodes.length,
    displayEdges.length,
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
    rememberContext();
    setGrowing(false);
    if (activeFanAnchor) {
      const target = selected[0] || activeFanAnchor;
      const entry = fanEntry.current;
      if (
        entry &&
        target === entry.anchorId &&
        next === entry.mode &&
        familyView.mode === entry.familyMode
      ) {
        clearReturnTarget();
        restoreToken.current += 1;
        setRestoreViewport({
          viewport: entry.viewport,
          token: restoreToken.current,
        });
      } else returnToPerson(target);
      fanEntry.current = null;
    }
    setFanAnchor(null);
    setMode(next);
    setEdgeChoices([]);
  }
  return (
    <TreeActions.Provider value={actions}>
      <div
        ref={container}
        className={`tree-canvas mode-${mode} ${activeFanAnchor ? "is-fan" : ""} ${fanRevealing ? "is-fan-revealing" : ""} ${growthPreparing ? "is-growth-preparing" : ""} ${growthActive ? "is-growing" : ""} ${layoutSettling ? "is-layout-settling" : ""} ${screen.fullscreen ? "is-fullscreen" : ""}`}
        style={growthCanvasStyle}
        tabIndex={-1}
        aria-busy={growthPreparing || growthActive}
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
                {props.assistantFilter.label}: {visible.size} из{" "}
                {family.people.length}
              </span>
              <button
                type="button"
                onClick={() => {
                props.onClearAssistantFilter?.();
                familyView.showAll();
                }}
              >
                Всё древо
              </button>
            </div>
          )}
          {family.people.length > 0 &&
            !props.restricted &&
            !props.assistantFilter && (
            <FamilyViewTools
              onShare={
                root && props.onShare
                  ? () => props.onShare!(root, [...visible])
                  : undefined
              }
                anchor={
                  activeFanAnchor
                    ? peopleMap.get(activeFanAnchor)
                    : root
                      ? peopleMap.get(root)
                      : undefined
                }
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
                fanEntry.current = null;
                setFanAnchor(null);
                familyView.enter();
              }}
              onCommon={() => {
                props.onClearAssistantFilter?.();
                rememberContext();
                clearReturnTarget();
                fanEntry.current = null;
                setFanAnchor(null);
                familyView.enterCommon();
              }}
              onFan={() => {
                if (activeFanAnchor) {
                  const target = selected[0] || activeFanAnchor;
                  const entry = fanEntry.current;
                  setFanRevealing(false);
                  setFanAnchor(null);
                  if (entry && target === entry.anchorId && mode === entry.mode) {
                    clearReturnTarget();
                    restoreToken.current += 1;
                    setRestoreViewport({
                      viewport: entry.viewport,
                      token: restoreToken.current,
                    });
                  } else returnToPerson(target);
                  fanEntry.current = null;
                  return;
                }
                const next = selected[0] || root || familyView.defaultAnchor;
                if (!next) return;
                const reduced = window.matchMedia(
                  "(prefers-reduced-motion: reduce)",
                ).matches;
                rememberContext();
                clearReturnTarget();
                fanEntry.current = {
                  anchorId: next,
                  mode,
                  familyMode: familyView.mode,
                  viewport: flow.getViewport(),
                };
                setGrowing(false);
                setEdgeChoices([]);
                setCreateAt(null);
                setFanRevealing(!reduced);
                setFanAnchor(next);
              }}
              fanActive={!!activeFanAnchor}
              onAll={() => {
                props.onClearAssistantFilter?.();
                const target = selected[0] || activeFanAnchor || root;
                const entry = fanEntry.current;
                const sameFanPerson =
                  !!activeFanAnchor &&
                  !!entry &&
                  target === entry.anchorId &&
                  mode === entry.mode &&
                  entry.familyMode === "all";
                if (!sameFanPerson) rememberContext();
                setFanAnchor(null);
                familyView.showAll();
                if (sameFanPerson) {
                  clearReturnTarget();
                  restoreToken.current += 1;
                  setRestoreViewport({
                    viewport: entry.viewport,
                    token: restoreToken.current,
                  });
                } else returnToPerson(target);
                fanEntry.current = null;
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
            nodes={renderedNodes}
            edges={renderedEdges}
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
                id:
                  occurrencePeople.get(state.fromNode.id) || state.fromNode.id,
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
                  Math.hypot(event.clientX - last.x, event.clientY - last.y) <
                    30
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
          panOnScroll={!growthLocked}
          zoomOnScroll={false}
          zoomOnPinch={!growthLocked}
          zoomOnDoubleClick={!growthLocked && !screen.fullscreen}
          selectionOnDrag={false}
          panOnDrag={growthLocked ? false : [0, 1]}
          minZoom={0.05}
          maxZoom={1.8}
          // Culling uses final coordinates, not the CSS-interpolated position.
          // Keep nodes mounted while they move, even across the viewport edge.
          onlyRenderVisibleElements={
            !layoutSettling && (!growing || displayNodes.length > 500)
          }
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
        {!activeFanAnchor && mode === "timeline" && (
          <HorizontalTimeline
            people={timelinePeople}
            selected={selected}
            focus={focus}
            onChoose={onChoose}
          />
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
