import {
  memo,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  Panel,
  useReactFlow,
  useStore,
  type Connection as FlowConnection,
  type Viewport,
} from "@xyflow/react";
import {
  ArrowLeftRight,
  ChartNoAxesGantt,
  Maximize2,
  Plus,
  GitBranch,
  Link2,
  RotateCcw,
  Settings,
  Download,
  Upload,
  TreeDeciduous,
} from "lucide-react";
import {
  archiveConnections,
  fullName,
  safeUrl,
  type Family,
  type ArchiveUser,
  type GraphConnection,
  type LayoutPerson,
  type TreeMode,
  type TreeColorScheme,
} from "../../domain";
import { archiveContextAt } from "../../domain/archive-context.ts";
import { mediaPreview } from "../../domain/media-preview.ts";
import { familyNeighbors, withoutReviewPeople } from "../../domain/family-neighborhood.ts";
import { PersonNode, TreeActions, type PersonNodeType } from "./person-node";
import { DistantPortraits } from "./distant-portraits";
import { TreeGpuScene } from "./tree-gpu-scene";
import { GpuPortraitCache } from "./gpu-portrait-cache";
import { Spatial } from "../../domain/edge-routing";
import { useLongPress } from "./use-long-press";
import { hitDistantScene } from "./distant-scene-hit";
import { useMiddlePersonAnchor } from "./use-middle-person-anchor";
import { createPersonRelationLabels, kinshipLabelKey } from "./person-relation-label";
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
import { generationScope } from "../../domain/tree-generation-scope";
import type { TreeGenerationLimits } from "../../domain/tree-preferences";
import { useTreeLayout } from "./use-tree-layout";
import { FamilyViewTools } from "./family-view-tools";
import "../../styles/family-view.css";
import { useTreeFullscreen } from "./use-tree-fullscreen";
import { ArchiveSummary } from "../archive-summary";
import { relativeAtHandle } from "../../domain/tree-interactions";
import { applyTreeEdgePermissions, prepareTreeEdges } from "./tree-edge-adapter";
import { buildTreeNodeModel } from "./tree-node-model";
import { treeRenderFamilyKey } from "./tree-render-family";
import { TreeCameraTools } from "./tree-camera-tools";
import { fitTreeNodes, type TreeFitOptions } from "./tree-camera-fit";
import { TreeEdgeChoices } from "./tree-edge-choices";
import {
  TREE_LAYOUT_TRANSITION_MS,
  treeGrowthCanvasStyle,
  treeGrowthDelays,
  treeGrowthDuration,
  treeGrowthInputKey,
} from "./tree-growth";
import { TreeCreateAt, type TreeCreateAtDraft } from "./tree-create-at";
import { PERSON_FOCUS_ZOOM, useTreeCameraState } from "./use-tree-camera-state";
import { familySpotlight } from "./family-spotlight";
import { FanChart } from "./fan-chart";
import { captureFanMorphSources, runFanMorph, type FanMorphSource } from "./fan-morph";
import { useTreeGrowthInputLock } from "./use-tree-growth-input-lock";
import { useEdgePan } from "./use-edge-pan";
import { treeNodeSize } from "../../domain/tree-layout-constants";
import {
  treeExportPeople,
  type TreeExportScope,
} from "../../domain/tree-export-selection";

export type ConnectionDraft = {
  from: string;
  to: string;
  type: GraphConnection["type"];
  original?: GraphConnection;
  note?: string;
    sources?: GraphConnection["sources"];
    confidence?: GraphConnection["confidence"];
  twinKind?: GraphConnection["twinKind"];
  hint?: string;
};
const emptyFlowNodes: (PersonNodeType | HouseholdNodeType)[] = [];
const emptyFlowEdges: RelationshipEdgeType[] = [];
export type TreeFocus = {
  ids: string[];
  token: number;
  purpose?: "family";
  groupId?: string;
};
export type AssistantTreeFilter =
  | { ids: string[]; label: string; token: number }
  | { excludeNeedsReview: true; label: string; token: number };
export type TreeCanvasHandle = {
  visiblePersonIds: (signal?: AbortSignal) => Promise<string[]>;
  exportPdf: (signal?: AbortSignal, scope?: TreeExportScope, anchorId?: string, generations?: number) => Promise<void>;
  exportPng: (signal?: AbortSignal, scope?: TreeExportScope, anchorId?: string, generations?: number) => Promise<void>;
};
type Props = {
  onPreferences?: () => void;
  onExport?: () => void;
  onImport?: () => void;
  onRename?: () => void;
  onAddSelf?: () => void;
  comparisonAction?: ReactNode;
  restricted?: boolean;
  onShare?: (anchorId: string, personIds: string[]) => void;
  onPublishPerson?: (personId: string) => void;
  publicationUpdate?: { personId: string; published: boolean; archiveId: string | null } | null;
  family: Family;
  user: ArchiveUser | null;
  canEdit: boolean;
  allowDragConnect?: boolean;
  busy: boolean;
  reverse: boolean;
  colorScheme?: TreeColorScheme;
  generationLimits?: TreeGenerationLimits | null;
  onGenerationAnchor?: (id: string) => Promise<void>;
  selected: string[];
  selectedEdge?: string;
  onChoose: (id: string, additive?: boolean) => void;
  onSelectOnly: (id: string) => void;
  onEdge: (edge: GraphConnection) => void;
  onConnect: (draft: ConnectionDraft) => void;
  onClear: () => void;
  onAdd: () => void;
  onAddRelative: (id: string, type: "parent" | "child" | "spouse") => void;
  onLink: () => void;
  focus: TreeFocus | null;
  assistantFilter?: AssistantTreeFilter | null;
  onClearAssistantFilter?: () => void;
  zoomRequest?: { token: number; direction: "in" | "out" };
  preview: ConnectionDraft | null;
  query: string;
  highlighted: string[];
  spotlight?: string[];
  onIntroComplete?: () => void;
  skipInitialGrowth?: boolean;
  onGrowthChange?: (active: boolean) => void;
};
const nodeTypes = { person: PersonNode, household: HouseholdNode },
  edgeTypes = { relationship: RelationshipEdge };
const Canvas = forwardRef<TreeCanvasHandle, Props>(function Canvas(
  props,
  exportRef,
) {
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element)?.closest(".tree-context-menu"))
        setContextMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [contextMenu]);
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
    onSelectOnly,
    onEdge,
    onConnect,
    focus,
  } = props;
  // Detail pages hydrate the live archive without changing its visible graph.
  // Retain render inputs until a graph/card field changes.
  const renderFamilyKey = useMemo(
    () => treeRenderFamilyKey(family),
    [family],
  );
  const renderFamily = useMemo(() => JSON.parse(renderFamilyKey) as Family, [renderFamilyKey]);
  const currentPeople = useMemo(() => new Map(family.people.map((person) => [person.id, person])), [family.people]);
  // Comparing two people can return fresh arrays for an unchanged kinship path.
  const highlightedKey = JSON.stringify(props.highlighted);
  const highlighted = useMemo(() => JSON.parse(highlightedKey) as string[], [highlightedKey]);
  const spotlightKey = JSON.stringify(props.spotlight || []);
  const spotlight = useMemo(() => JSON.parse(spotlightKey) as string[], [spotlightKey]);
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
  const branchToken = useRef(0);
  const [branchAnchor, setBranchAnchor] = useState<{
    personId: string;
    occurrenceId: string | null;
    position: { x: number; y: number };
    viewport: Viewport;
    layoutKey: string;
    token: number;
  } | null>(null);
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
  const fanMorphSources = useRef<FanMorphSource[]>([]);
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
  const [growing, setGrowing] = useState(() => !props.skipInitialGrowth);
  useEffect(() => {
    if (!activeFanAnchor || !fanRevealing) return;
    const element = container.current;
    if (!element) {
      setFanRevealing(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    void runFanMorph(element, fanMorphSources.current, controller.signal).finally(() => {
      if (!active) return;
      fanMorphSources.current = [];
      setFanRevealing(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [activeFanAnchor, fanRevealing]);
  const [initialCameraReady, setInitialCameraReady] = useState(false);
  const [manualCameraOverride, setManualCameraOverride] = useState(false);
  const [introCameraFinished, setIntroCameraFinished] = useState(false);
  const introMoving =
    !growing && initialCameraReady && !introCameraFinished &&
    !!user?.personId && !props.skipInitialGrowth && !focus &&
    !selected.length && !manualCameraOverride;
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const distantZoom = useStore((state) => state.transform[2] < 0.18);
  const [growthStarted, setGrowthStarted] = useState(false);
  const [growthRevealed, setGrowthRevealed] = useState(false);
  const markInitialCameraReady = useCallback(
    () => setInitialCameraReady(true),
    [],
  );
  const growthPreparing = growing && family.people.length > 0 && !growthRevealed;
  const growthActive = growing && growthStarted;
  const growthLocked = growthPreparing || growthActive;
  // A click before the first fitView completes would be overwritten by that
  // initial camera placement, especially with reduced motion / a slow layout.
  const cameraLocked =
    (!initialCameraReady && family.people.length > 0) || growthLocked || introMoving;
  const onGrowthChange = props.onGrowthChange;
  useLayoutEffect(() => {
    if (growthLocked) {
      onGrowthChange?.(true);
      return;
    }
    // Let React Flow commit the final growth frame before opening an inspector
    // (and potentially resizing the viewport during the personal camera move).
    const frame = requestAnimationFrame(() => onGrowthChange?.(false));
    return () => cancelAnimationFrame(frame);
  }, [growthLocked, onGrowthChange]);
  // Timeline has its own scroll controls and does not wait for the hidden
  // React Flow camera to finish its initial positioning.
  useTreeGrowthInputLock(container, mode !== "timeline" && cameraLocked, !growthLocked);
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
  const [extraVisible, setExtraVisible] = useState(false);
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
    renderFamily,
    selected,
    highlighted,
    focus,
    props.preview,
  );
  const showAllBranches = familyView.showAll;
  const filterToken = props.assistantFilter?.token;
  useEffect(() => {
    if (filterToken) {
      // An explicit projection replaces the intro, including a zero-card
      // result that has no animation frame to release the input lock.
      setGrowing(false);
      setIntroCameraFinished(true);
      showAllBranches();
      setFanAnchor(null);
    }
  }, [filterToken, showAllBranches]);
  const { anchor: root, collapsed, toggle: toggleView } = familyView;
  const generationLimitsKey = JSON.stringify(
    props.generationLimits ? [
      props.generationLimits.anchorId,
      props.generationLimits.ancestors,
      props.generationLimits.descendants,
      props.generationLimits.collateral,
    ] : null,
  );
  const previousGenerationLimits = useRef({
    key: generationLimitsKey,
    anchorId: props.generationLimits?.anchorId,
  });
  const scopeFocusToken = useRef(0);
  const [scopeFocus, setScopeFocus] = useState<{
    id: string;
    token: number;
    previousFocusToken: number | null;
  } | null>(null);
  const generationRange = useMemo(
    () => props.generationLimits
      ? generationScope(
          familyNeighbors({ people: renderFamily.people, links: renderFamily.links }),
          props.generationLimits,
        )
      : null,
    [renderFamily.people, renderFamily.links, props.generationLimits],
  );
  const generationVisible = useMemo(() => {
    if (!generationRange) return familyView.visible;
    return new Set([...familyView.visible].filter((id) => generationRange.has(id)));
  }, [generationRange, familyView.visible]);
  const visible = useMemo(() => {
    if (!props.assistantFilter) return generationVisible;
    if ("excludeNeedsReview" in props.assistantFilter)
      return withoutReviewPeople(renderFamily.people, generationVisible);
    return new Set(
      props.assistantFilter.ids.filter((id) => generationVisible.has(id)),
    );
  }, [renderFamily.people, generationVisible, props.assistantFilter]);
  const timelinePeople = useMemo(
    () => family.people.filter((person) => visible.has(person.id)),
    [family.people, visible],
  );
  const flow = useReactFlow<
    PersonNodeType | HouseholdNodeType,
    RelationshipEdgeType
  >();
  const edgePan = useEdgePan(
    flow,
    !cameraLocked && !activeFanAnchor && mode !== "timeline",
  );
  const lastAssistantZoom = useRef(0);
  const context = props.assistantFilter
    ? `${mode}:research:${props.assistantFilter.token}:portrait`
    : `${mode}:${familyView.mode}:${root || "all"}:portrait`;
  useTouchZoom(container, flow, !cameraLocked && !screen.fullscreen && !activeFanAnchor && mode !== "timeline");
  useCtrlWheelZoom(container, flow, !cameraLocked && !activeFanAnchor && mode !== "timeline");
  const { geometry, renderVisible, ready, problem, layoutBusy, layoutKey } =
    useTreeLayout(
      renderFamily,
      visible,
      layoutMode,
      reverse,
      user
        ? JSON.stringify([
            archiveContextAt(window.location.pathname)?.id || "default",
            user.id,
            user.role,
            user.treeAccess,
            user.personId,
          ])
        : null,
    );
  const nodeWidth = geometry?.nodeSize?.width ?? treeNodeSize().width;
  const nodeHeight = geometry?.nodeSize?.height ?? treeNodeSize().height;
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
  const progressiveIntroRequested = growing && renderVisible.size >= 500 &&
    (distantZoom || !initialCameraReady) && !extraVisible && !activeFanAnchor && mode !== "timeline";
  const growthInputKey = useMemo(
    () => treeGrowthInputKey(renderFamily.people),
    [renderFamily.people],
  );
  const growthPeople = useMemo(
    () => JSON.parse(growthInputKey) as LayoutPerson[],
    [growthInputKey],
  );
  const growthMinimumBudget = progressiveIntroRequested && renderVisible.size >= 2500 ? 2200 : 0;
  // Detail pages replace person objects without changing the timing facts.
  // Keep the same schedule so they cannot restart the introduction's timer.
  const growthDelays = useMemo(
    () => treeGrowthDelays(growthPeople, growthMinimumBudget),
    [growthPeople, growthMinimumBudget],
  );
  const growthCanvasStyle = useMemo(
    () => treeGrowthCanvasStyle(growthDelays),
    [growthDelays],
  );
  const nodeModel = useMemo(
    () =>
      buildTreeNodeModel({
        family: renderFamily,
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
        spotlight: new Set(spotlight),
        spotlightOccurrences: spotlightNodes
          ? new Set(spotlightNodes)
          : undefined,
        growthDelays,
      }),
    [
      renderFamily,
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
      spotlight,
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
  const cameraModel = useRef({ nodes: displayNodes, personOccurrences });
  useLayoutEffect(() => {
    cameraModel.current = { nodes: displayNodes, personOccurrences };
  }, [displayNodes, personOccurrences]);
  const fitTree = useCallback((options?: TreeFitOptions) => fitTreeNodes(
    flow, cameraModel.current.nodes, { width: canvasWidth, height: canvasHeight },
    options, cameraModel.current.personOccurrences,
  ), [flow, canvasWidth, canvasHeight]);
  useEffect(() => {
    const previous = previousGenerationLimits.current;
    if (previous.key === generationLimitsKey) return;
    const anchorId = props.generationLimits?.anchorId || previous.anchorId;
    previousGenerationLimits.current = {
      key: generationLimitsKey,
      anchorId: props.generationLimits?.anchorId,
    };
    if (!anchorId || !visible.has(anchorId)) return;
    // Stop the previous flight; the new request waits for current Worker geometry.
    introHandled.current = true;
    setGrowing(false);
    setIntroCameraFinished(true);
    setManualCameraOverride(true);
    setBranchAnchor(null);
    setRestoreViewport(null);
    clearReturnTarget();
    void flow.setViewport(flow.getViewport(), { duration: 0 });
    scopeFocusToken.current += 1;
    setScopeFocus({
      id: anchorId,
      // Explicit navigation uses positive tokens; -1 is the camera's sentinel.
      token: -scopeFocusToken.current - 1,
      previousFocusToken: focus?.token ?? null,
    });
  }, [generationLimitsKey, props.generationLimits?.anchorId, visible, focus?.token, flow, clearReturnTarget]);
  useEffect(() => {
    setScopeFocus((current) => current && current.previousFocusToken !== (focus?.token ?? null)
      ? null : current);
  }, [focus?.token]);
  const activeScopeFocus = scopeFocus?.previousFocusToken === (focus?.token ?? null)
    ? scopeFocus : null;
  const scopeOccurrence = activeScopeFocus
    ? personOccurrences.get(activeScopeFocus.id)?.find((id) => positions.has(id))
    : undefined;
  const effectiveCameraFocus = useMemo(() => activeScopeFocus
    ? scopeOccurrence ? {
      ids: [scopeOccurrence], token: activeScopeFocus.token, recenterOnResize: false,
    } : null
    : cameraFocus, [scopeOccurrence, activeScopeFocus, cameraFocus]);
  const effectiveTimelineFocus = useMemo(() => activeScopeFocus
    ? { ids: [activeScopeFocus.id], token: activeScopeFocus.token }
    : focus, [activeScopeFocus, focus]);
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
      (!growthStarted && !reduced)
    )
      return;
    const timer = window.setTimeout(
      () => setGrowing(false),
      reduced ? 0 : treeGrowthDuration(maxGrowthDelay, growthDelays),
    );
    return () => window.clearTimeout(timer);
  }, [
    growing,
    ready,
    nodes.length,
    maxGrowthDelay,
    growthDelays,
    growthStarted,
    problem,
  ]);
  const introOccurrence = user?.personId
    ? personOccurrences.get(user.personId)?.[0]
    : undefined;
  const introPosition = introOccurrence
    ? positions.get(introOccurrence)
    : undefined;
  const introX = introPosition?.x;
  const introY = introPosition?.y;
  const introPortraitsReady = useRef(true);
  useEffect(() => {
    if (!growing || !ready || introX === undefined || introY === undefined ||
        !canvasWidth || !canvasHeight) {
      introPortraitsReady.current = true;
      return;
    }
    const nearby = displayNodes.flatMap((node) => {
      if (node.type !== "person") return [];
      const distance = Math.abs(node.position.x - introX) +
        Math.abs(node.position.y - introY);
      if (Math.abs(node.position.x - introX) > canvasWidth / PERSON_FOCUS_ZOOM ||
          Math.abs(node.position.y - introY) > canvasHeight / PERSON_FOCUS_ZOOM)
        return [];
      const url = mediaPreview(safeUrl(node.data.person.photo));
      return url ? [{ url, distance }] : [];
    }).sort((a, b) => a.distance - b.distance).slice(0, 48);
    if (!nearby.length) {
      introPortraitsReady.current = true;
      return;
    }
    introPortraitsReady.current = false;
    let active = true;
    void Promise.all(nearby.map(({ url }) => {
      const image = new Image();
      image.src = url;
      return image.decode().catch(() => {});
    })).then(() => {
      if (active) introPortraitsReady.current = true;
    });
    return () => { active = false; };
  }, [growing, ready, introX, introY, canvasWidth, canvasHeight, displayNodes]);
  const keepRequestedFocus =
    props.skipInitialGrowth || !!focus || selected.length > 0;
  useEffect(() => {
    if (
      growing ||
      !initialCameraReady ||
      !ready ||
      !nodes.length ||
      !canvasWidth ||
      !canvasHeight ||
      introHandled.current
    )
      return;
    let active = true;
    const done = () => {
      if (active) {
        // Starting a transition does not mean it has reached its destination.
        // A resize or a layout update can restart this effect mid-flight.
        introHandled.current = true;
        setIntroCameraFinished(true);
        introComplete.current?.();
      }
    };
    if (
      introX === undefined ||
      introY === undefined ||
      keepRequestedFocus ||
      manualCameraOverride ||
      familyView.mode !== "all"
    ) {
      done();
      return () => {
        active = false;
      };
    }
    const camera = flow.getViewport();
    if (
      Math.abs(camera.zoom - PERSON_FOCUS_ZOOM) < 0.001 &&
      Math.abs(
        camera.x + (introX + nodeWidth / 2) * camera.zoom - canvasWidth / 2,
      ) < 2 &&
      Math.abs(
        camera.y + (introY + nodeHeight / 2) * camera.zoom - canvasHeight / 2,
      ) < 2
    ) {
      done();
      return () => {
        active = false;
      };
    }
    // Use worker geometry: fitView depends on React Flow's measured nodes,
    // which can still be updating as growth and virtualization finish.
    void flow
      .setCenter(introX + nodeWidth / 2, introY + nodeHeight / 2, {
        zoom: PERSON_FOCUS_ZOOM,
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
    introX,
    introY,
    nodeWidth,
    nodeHeight,
    keepRequestedFocus,
    manualCameraOverride,
    canvasWidth,
    canvasHeight,
    familyView.mode,
    flow,
    narrow,
  ]);
  const { rememberContext, resetContext, rememberViewport } =
    useTreeCameraState({
      flow,
      fitTree,
      geometry,
      nodeCount: nodes.length,
      mode: layoutMode,
      reverse,
      ready,
      focusReady: !growing && introCameraFinished,
      focus: effectiveCameraFocus,
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
      initialPersonId:
        mode !== "timeline" &&
        !props.skipInitialGrowth &&
        familyView.mode === "all" &&
        !props.assistantFilter &&
        !focus &&
        !selected.length
          ? user?.personId || null : null,
      onInitialViewReady: markInitialCameraReady,
      manualCameraOverride,
      expanded: familyView.expanded,
      collapsed,
      layoutKey,
      branchAnchor,
    });
  const toggleBranch = useCallback(
    (id: string, occurrenceId?: string) => {
      const occurrence =
        occurrenceId && positions.has(occurrenceId)
          ? occurrenceId
          : personOccurrences.get(id)?.find((candidate) => positions.has(candidate));
      const position = occurrence ? positions.get(occurrence) : undefined;
      if (position) {
        branchToken.current += 1;
        setBranchAnchor({
          personId: id,
          occurrenceId: occurrence || null,
          position,
          viewport: flow.getViewport(),
          layoutKey,
          token: branchToken.current,
        });
      }
      setGrowing(false);
      toggleView(id);
    },
    [flow, layoutKey, personOccurrences, positions, toggleView],
  );
  const gpuArchiveContext = typeof window === "undefined" ? null :
    archiveContextAt(window.location.pathname);
  const gpuSharedToken = typeof window === "undefined" ? null :
    /^\/s\/([A-Za-z0-9_-]{43})$/.exec(
      gpuArchiveContext?.innerPath || window.location.pathname,
    )?.[1] || null;
  // Person routes share the archive snapshot; account, share grant and read policy isolate caches.
  const gpuScope = JSON.stringify([
    gpuArchiveContext?.id || "default", gpuSharedToken,
    user?.id || null, user?.role || null, user?.treeAccess || null,
    user?.personId || null, user?.fullAccess ?? null,
    user?.platformAdmin ?? null, user?.approved ?? null,
    props.restricted ?? false,
  ]);
  const kinshipDay = new Date().toISOString().slice(0, 10);
  const labelKey = useMemo(() => user?.personId ? kinshipLabelKey(
    renderFamily.people, renderFamily.links || [], renderFamily.unions || [], kinshipDay, gpuScope,
  ) : "", [renderFamily.people, renderFamily.links, renderFamily.unions, kinshipDay, gpuScope, user?.personId]);
  const relationLabel = useMemo(() => {
    if (!user?.id || !user.personId) return () => "";
    return createPersonRelationLabels(labelKey, user?.personId || undefined);
    // Archive, share grant and read policy isolate the retained snapshot/cache.
  }, [labelKey, user?.id, user?.personId]);
  const actions = useMemo(
    () => ({
      relationLabel,
      publishPerson: props.onPublishPerson,
      publicationUpdate: props.publicationUpdate,
      choose: (id: string, additive = false) => {
        setEdgeChoices([]);
        setScopeFocus(null);
        setManualCameraOverride(true);
        introHandled.current = true;
        void flow.setViewport(flow.getViewport(), { duration: 0 });
        if (!introCameraFinished) setIntroCameraFinished(true);
        onChoose(id, additive);
      },
      selectOnly: (id: string) => {
        setEdgeChoices([]);
        setScopeFocus(null);
        setManualCameraOverride(true);
        introHandled.current = true;
        void flow.setViewport(flow.getViewport(), { duration: 0 });
        if (!introCameraFinished) setIntroCameraFinished(true);
        onSelectOnly(id);
      },
      collapse: toggleBranch,
      expand: toggleBranch,
      reference: (personId: string, occurrenceId: string) => {
        const ids = personOccurrences.get(personId) || [];
        const next = ids[(ids.indexOf(occurrenceId) + 1) % ids.length];
        if (next)
          void fitTree({
            ids: [next],
            maxZoom: 1,
            padding: 0.6,
          });
      },
    }),
    [
      onChoose,
      onSelectOnly,
      toggleBranch,
      personOccurrences,
      flow,
      fitTree,
      introCameraFinished,
      relationLabel,
      props.onPublishPerson,
      props.publicationUpdate,
    ],
  );
  const connections = useMemo(() => archiveConnections(renderFamily), [renderFamily]);
  const preparedEdges = useMemo(
    () =>
      prepareTreeEdges({
        mode: layoutMode,
        geometry,
        connections,
        visible: renderVisible,
        positions,
        occurrencePeople,
        peopleMap,
        highlighted,
        selectedEdge: props.selectedEdge,
        extraVisible,
        preview: props.preview,
        onEdge,
        onChoices: setEdgeChoices,
        growthDelays,
      }),
    [
      layoutMode,
      geometry,
      connections,
      renderVisible,
      positions,
      occurrencePeople,
      peopleMap,
      highlighted,
      props.selectedEdge,
      extraVisible,
      props.preview,
      onEdge,
      growthDelays,
    ],
  );
  const displayEdges = useMemo(
    () => applyTreeEdgePermissions(preparedEdges, {
      family: renderFamily,
      user,
      peopleMap,
      canEdit: props.canEdit,
      busy: props.busy,
    }),
    [preparedEdges, renderFamily, user, peopleMap, props.canEdit, props.busy],
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
  const overviewAvailable = mode !== "timeline" && !activeFanAnchor &&
    nodes.length >= 600 && !growing && !layoutSettling;
  const portraitPeople = useMemo(() => nodes.map((node) => node.data.person), [nodes]);
  const distantScene = overviewAvailable && distantZoom;
  // Use the existing distant canvas scene for large introductions instead of
  // mounting hundreds of SVG edge wrappers during the short growth sequence.
  const progressiveCanvasIntro = progressiveIntroRequested && nodes.length >= 500;
  const [gpuReadyScene, setGpuReadyScene] = useState<{ geometry: typeof geometry; scope: string } | null>(null);
  const [gpuFailedScope, setGpuFailedScope] = useState<string | null>(null);
  const [gpuFallbackReason, setGpuFallbackReason] = useState("");
  const [gpuHovered, setGpuHovered] = useState("");
  const [gpuFocused, setGpuFocused] = useState("");
  const [connecting, setConnecting] = useState(false);
  const gpuOverlayEdges = useMemo(() => renderedEdges.filter((edge) => edge.selected ||
    !["parent", "spouse"].includes(edge.data?.connection.type || "")), [renderedEdges]);
  const gpuEligible = nodes.length >= 500 && !growing && !layoutSettling && !layoutBusy &&
    !activeFanAnchor && mode !== "timeline" && !connecting && gpuFailedScope !== gpuScope &&
    gpuOverlayEdges.length <= 64 && nodes.every((node) => GpuPortraitCache.supported(node.data.person.photo));
  // A remounted canvas needs its own first frame and portrait handoff, even
  // when cancelling a connection leaves the layout geometry unchanged.
  if (!gpuEligible && gpuReadyScene) setGpuReadyScene(null);
  const gpuActive = gpuEligible && gpuReadyScene?.geometry === geometry && gpuReadyScene?.scope === gpuScope;
  const gpuReady = useCallback(() => setGpuReadyScene({ geometry, scope: gpuScope }), [geometry, gpuScope]);
  const gpuFailure = useCallback((reason: string) => {
    setGpuFailedScope(gpuScope); setGpuReadyScene(null); setGpuFallbackReason(reason);
  }, [gpuScope]);
  const gpuEdges = useMemo(() => {
    const overlays = new Set(gpuOverlayEdges.map((edge) => edge.id));
    return renderedEdges.filter((edge) => !overlays.has(edge.id));
  }, [renderedEdges, gpuOverlayEdges]);
  const gpuActions = useMemo(() => ({
    ...actions,
    currentPeople,
    gpu: gpuActive,
    // React Flow first mounts at zoom 1, before fitView. Fetching portraits
    // there would request every thumb and delay hydration/the GPU handoff.
    deferPortraits: !initialCameraReady || (renderedNodes.length >= 500 &&
      (layoutSettling || layoutBusy || (gpuEligible && !gpuActive))),
  }), [actions, currentPeople, gpuActive, initialCameraReady, renderedNodes.length, layoutSettling, layoutBusy, gpuEligible]);
  const gpuPinnedOverlayIds = useMemo(() => {
    const ids = new Set([gpuFocused]);
    for (const node of nodes.filter((node) => node.selected).slice(0, 24)) ids.add(node.id);
    for (const edge of gpuOverlayEdges) { ids.add(edge.source); ids.add(edge.target); }
    return ids;
  }, [nodes, gpuFocused, gpuOverlayEdges]);
  const gpuOverlayIds = useMemo(() => {
    // Hovering a node already shown for selection/focus must not replace the
    // React Flow nodes: their measured handle bounds are needed immediately on mousedown.
    if (!gpuHovered || gpuPinnedOverlayIds.has(gpuHovered)) return gpuPinnedOverlayIds;
    return new Set([...gpuPinnedOverlayIds, gpuHovered]);
  }, [gpuPinnedOverlayIds, gpuHovered]);
  const distantOverlayIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of gpuOverlayEdges) { ids.add(edge.source); ids.add(edge.target); }
    return ids;
  }, [gpuOverlayEdges]);
  const distantOverlayEdgeIds = useMemo(() =>
    new Set(gpuOverlayEdges.map((edge) => edge.id)), [gpuOverlayEdges]);
  const canvasEdges = useMemo(() => distantScene
    ? displayEdges.filter((edge) => !distantOverlayEdgeIds.has(edge.id))
    : displayEdges, [displayEdges, distantScene, distantOverlayEdgeIds]);
  const gpuHitIndex = useMemo(() => {
    const index = new Spatial<{ left: number; right: number; top: number; bottom: number; node: PersonNodeType }>();
    for (const node of nodes) index.add({ node, left: node.position.x, top: node.position.y,
      right: node.position.x + (node.width || 220), bottom: node.position.y + (node.height || 264) });
    return index;
  }, [nodes]);
  const gpuPersonAt = (clientX: number, clientY: number) => {
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds) return;
    const camera = flow.getViewport(), x = (clientX - bounds.left - camera.x) / camera.zoom,
      y = (clientY - bounds.top - camera.y) / camera.zoom;
    return gpuHitIndex.query({ left: x, right: x, top: y, bottom: y })
      .sort((a, b) => Math.hypot((a.left + a.right) / 2 - x, (a.top + a.bottom) / 2 - y) -
        Math.hypot((b.left + b.right) / 2 - x, (b.top + b.bottom) / 2 - y))[0]?.node;
  };
  const gpuPressPerson = useRef("");
  const gpuLongPress = useLongPress<HTMLDivElement>(() => {
    if (gpuPressPerson.current) actions.selectOnly(gpuPressPerson.current);
  });
  useEffect(() => {
    if (!gpuActive || !gpuFocused) return;
    const frame = requestAnimationFrame(() => container.current?.querySelector<HTMLButtonElement>(
      `.react-flow__node[data-id="${CSS.escape(gpuFocused)}"] .flow-person-content`,
    )?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [gpuFocused, gpuActive]);
  const [anchorNotice, setAnchorNotice] = useState("");
  useEffect(() => {
    if (!anchorNotice) return;
    const timer = window.setTimeout(() => setAnchorNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [anchorNotice]);
  const savingAnchor = useRef(false);
  const { onGenerationAnchor } = props;
  const saveGenerationAnchor = useCallback(async (id: string) => {
    if (savingAnchor.current || !onGenerationAnchor) return false;
    savingAnchor.current = true;
    const person = currentPeople.get(id);
    try {
      await onGenerationAnchor(id);
      setAnchorNotice(`Опорный человек: ${person ? fullName(person) : id}`);
      return true;
    } catch (error: unknown) {
      setAnchorNotice(error instanceof Error ? error.message : "Не удалось сохранить опорного человека");
      return false;
    } finally {
      savingAnchor.current = false;
    }
  }, [onGenerationAnchor, currentPeople]);
  const reanchorHiddenPerson = useCallback(async (id: string) => {
    // Only exclusion by the generation window changes its anchor. Assistant
    // filters, collapsed branches and ordinary card selection keep their policy.
    if (!props.generationLimits || !generationRange || generationRange.has(id) ||
        !currentPeople.has(id)) return false;
    return saveGenerationAnchor(id);
  }, [props.generationLimits, generationRange, currentPeople, saveGenerationAnchor]);
  const focusSelected = async () => {
    if (selected.length === 1 && props.assistantFilter &&
        ("excludeNeedsReview" in props.assistantFilter
          ? currentPeople.get(selected[0])?.needsReview
          : !props.assistantFilter.ids.includes(selected[0]))) {
      setAnchorNotice("Человек скрыт фильтром исследования. Снимите фильтр, чтобы перейти к нему");
      return;
    }
    if (selected.length === 1 && await reanchorHiddenPerson(selected[0])) return;
    void fitTree({
      ids: selected,
      minZoom: selected.length === 1 ? PERSON_FOCUS_ZOOM : 0.05,
      maxZoom: selected.length === 1 ? PERSON_FOCUS_ZOOM : 1,
      padding: 0.4,
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 480,
      ease: (progress) => 1 - (1 - progress) ** 3,
    });
  };
  const middleAnchor = useMiddlePersonAnchor(
    !!props.onGenerationAnchor && !cameraLocked && !layoutBusy && !activeFanAnchor,
    (target, x, y) => {
      if (!(target instanceof Element)) return null;
      const content = target.closest(".flow-person-content, .timeline-person");
      if (content)
        return content.closest("[data-person-id]")?.getAttribute("data-person-id") ?? null;
      if (!(distantScene || gpuActive) || !target.closest(".react-flow__pane")) return null;
      const bounds = container.current?.getBoundingClientRect();
      return bounds
        ? hitDistantScene(nodes, displayEdges, flow.getViewport(), {
            x: x - bounds.left,
            y: y - bounds.top,
          })?.node?.data.person.id ?? null
        : null;
    },
    (id) => {
      void saveGenerationAnchor(id);
    },
  );
  const flowNodes = useMemo(() => gpuActive
    ? renderedNodes.map((node) => node.type === "household" ? ({ ...node, hidden: true }) : ({ ...node,
      hidden: !gpuOverlayIds.has(node.id), className: `${node.className || ""} tree-gpu-node-overlay` }))
    : distantScene
    ? renderedNodes.map((node) => node.type === "household" ? ({ ...node, hidden: true }) : ({
      ...node, hidden: !distantOverlayIds.has(node.id),
      className: `${node.className || ""} tree-gpu-node-overlay`,
    }))
    : progressiveCanvasIntro
    ? renderedNodes.map((node) => ({ ...node, hidden: true }))
    : renderedNodes, [renderedNodes, distantScene, progressiveCanvasIntro,
      gpuActive, gpuOverlayIds, distantOverlayIds]);
  const flowEdges = useMemo(() => gpuActive ? gpuOverlayEdges : distantScene ? gpuOverlayEdges : progressiveCanvasIntro
    // Hidden EdgeWrappers still subscribe to every camera update and resolve
    // their handles. Canvas owns these routes; React Flow only needs the nodes
    // (with dimensions intact) for fitView and person camera targets.
    ? []
    : renderedEdges, [renderedEdges, distantScene, progressiveCanvasIntro, gpuActive, gpuOverlayEdges]);
  const overviewHouseholds = useMemo(() => displayNodes.filter(
    (node): node is HouseholdNodeType => node.type === "household",
  ), [displayNodes]);
  const exportSnapshot = useRef({
    ready,
    layoutBusy,
    family,
    reverse,
    extraVisible,
    tree: {
      nodes: displayNodes,
      edges: displayEdges,
      actions,
      title: family.title,
      white: props.colorScheme === "white",
    },
  });
  useLayoutEffect(() => {
    exportSnapshot.current = {
      ready,
      layoutBusy,
      family,
      reverse,
      extraVisible,
      tree: {
        nodes: displayNodes,
        edges: displayEdges,
        actions,
        title: family.title,
        white: props.colorScheme === "white",
      },
    };
  }, [ready, layoutBusy, displayNodes, displayEdges, actions, family, reverse, extraVisible, props.colorScheme]);
  useImperativeHandle(
    exportRef,
    () => {
      const preparedTree = async (signal?: AbortSignal) => {
        for (let attempt = 0; attempt < 300; attempt++) {
          signal?.throwIfAborted();
          const current = exportSnapshot.current;
          if (current.ready && !current.layoutBusy) return current.tree;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Не удалось дождаться построения древа.");
      };
      const selectedTree = async (
        signal?: AbortSignal,
        scope: TreeExportScope = "current",
        anchorId?: string,
        generations = 5,
      ) => {
        if (scope === "current") return preparedTree(signal);
        const current = exportSnapshot.current;
        const { prepareTreeExport } = await import("./tree-export-model");
        return prepareTreeExport(
          current.family,
          treeExportPeople(current.family, scope, anchorId, generations),
          current.reverse,
          current.tree.white,
          current.tree.actions,
          signal,
          current.extraVisible,
        );
      };
      return {
        async visiblePersonIds(signal) {
          const tree = await preparedTree(signal);
          return [...new Set(tree.nodes.flatMap((node) =>
            node.type === "person" ? [node.data.person.id] : [],
          ))];
        },
        async exportPdf(signal, scope, anchorId, generations) {
          const tree = await selectedTree(signal, scope, anchorId, generations);
          const { exportTreePdf } = await import("./tree-pdf");
          await exportTreePdf(tree, signal);
        },
        async exportPng(signal, scope, anchorId, generations) {
          const tree = await selectedTree(signal, scope, anchorId, generations);
          const { exportTreePng } = await import("./tree-pdf");
          await exportTreePng(tree, signal);
        },
      };
    },
    [],
  );
  useEffect(() => {
    if (!growing || !ready || !initialCameraReady || growthStarted)
      return;
    let frame = 0;
    let mountAttempts = 0;
    const portraitDeadline = performance.now() + 3000;
    const startWhenMounted = () => {
      const element = container.current;
      if (!element) return;
      const mountedNodes = element.querySelectorAll(".react-flow__node").length;
      const mountedEdges = element.querySelectorAll(".react-flow__edge").length;
      const portraits = element.querySelectorAll<HTMLImageElement>(
        ".react-flow__node .person-avatar img",
      );
      const portraitsReady = Array.from(portraits).every((image) => image.complete);
      // React Flow measures nodes before rendering their edges. Give both a
      // shared animation start, or a late edge may follow its descendant card.
      const mounted = progressiveCanvasIntro
        ? !!element.querySelector(".tree-distant-portraits")
        :
        displayNodes.length <= 2000
          ? mountedNodes >= displayNodes.length &&
            mountedEdges >= displayEdges.length
          : mountAttempts >= 2 &&
            mountedNodes > 0 &&
            (!displayEdges.length || mountedEdges > 0);
      if (mounted && ((portraitsReady && introPortraitsReady.current) ||
          performance.now() >= portraitDeadline)) {
        setGrowthStarted(true);
      } else if (!mounted && ++mountAttempts >= 30) {
        setGrowthStarted(true);
      } else {
        frame = requestAnimationFrame(startWhenMounted);
      }
    };
    frame = requestAnimationFrame(startWhenMounted);
    return () => cancelAnimationFrame(frame);
  }, [
    growing,
    ready,
    initialCameraReady,
    growthStarted,
    displayNodes.length,
    displayEdges.length,
    progressiveCanvasIntro,
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
    setScopeFocus(null);
    setManualCameraOverride(true);
    void flow.setViewport(flow.getViewport(), { duration: 0 });
    if (!introCameraFinished) setIntroCameraFinished(true);
    setFanRevealing(false);
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
  const timelineActive = !activeFanAnchor && mode === "timeline";
  const preferencesAction = props.onPreferences && (
    <button
      type="button"
      className="tree-preferences-trigger"
      aria-label="Настройки древа"
      title="Настройки древа"
      aria-haspopup="dialog"
      disabled={growthActive}
      onClick={props.onPreferences}
    >
      <Settings size={19} aria-hidden="true" />
    </button>
  );
  return (
    <TreeActions.Provider value={gpuActions}>
      <div
        ref={container}
        data-layout-ready={ready}
        data-layout-people={renderVisible.size}
        className={`tree-canvas mode-${mode} ${props.colorScheme === "white" ? "theme-white" : ""} has-portrait-cards ${activeFanAnchor ? "is-fan" : ""} ${fanRevealing ? "is-fan-revealing" : ""} ${growthPreparing ? "is-growth-preparing" : ""} ${growthActive ? "is-growing" : ""} ${layoutSettling ? "is-layout-settling" : ""} ${screen.fullscreen ? "is-fullscreen" : ""}`}
        style={growthCanvasStyle}
        data-renderer={gpuActive ? "webgl2" : "react-flow"}
        data-gpu-scene-match={gpuReadyScene?.geometry === geometry && gpuReadyScene?.scope === gpuScope ? "true" : "false"}
        data-gpu-fallback={gpuFailedScope === gpuScope ? gpuFallbackReason || undefined : undefined}
        data-distant-overlay={distantScene && gpuOverlayEdges.length > 0 || undefined}
        role={gpuActive ? "application" : undefined}
        onPointerMoveCapture={(event) => {
          gpuLongPress.handlers.onPointerMove(event);
          if (!gpuActive || event.pointerType === "touch") return;
          const target = event.target as Element;
          const native = target.closest(".react-flow__node-person")?.getAttribute("data-id");
          const id = native || (target.closest(".react-flow__pane") && !event.buttons
            ? gpuPersonAt(event.clientX, event.clientY)?.id : "") || "";
          setGpuHovered((current) => current === id ? current : id);
        }}
        onPointerLeave={() => setGpuHovered("")}
        onPointerUpCapture={gpuLongPress.handlers.onPointerUp}
        onPointerCancelCapture={gpuLongPress.handlers.onPointerCancel}
        onLostPointerCapture={gpuLongPress.handlers.onLostPointerCapture}
        onFocusCapture={(event) => {
          const target = event.target as Element;
          const id = target.closest(".react-flow__node-person")?.getAttribute("data-id");
          if (gpuActive && id) setGpuFocused(id);
        }}
        onKeyDown={(event) => {
          if (!gpuActive || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) return;
          const target = event.target as HTMLElement;
          if (target !== container.current && !target.classList.contains("flow-person-content")) return;
          const camera = flow.getViewport();
          const cx = (canvasWidth / 2 - camera.x) / camera.zoom, cy = (canvasHeight / 2 - camera.y) / camera.zoom;
          const current = nodes.find((node) => node.id === gpuFocused) || [...nodes].sort((a, b) =>
            Math.hypot(a.position.x - cx, a.position.y - cy) - Math.hypot(b.position.x - cx, b.position.y - cy))[0];
          if (!current) return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Enter" || event.key === " ") { actions.choose(current.data.person.id, event.shiftKey); return; }
          const dx = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
          const dy = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
          const score = (node: PersonNodeType) => {
            const x = node.position.x - current.position.x, y = node.position.y - current.position.y;
            return x * dx + y * dy > 1 ? Math.hypot(x, y) + Math.abs(x * dy - y * dx) * 2 : Infinity;
          };
          const next = nodes.filter((node) => node.id !== current.id && Number.isFinite(score(node)))
            .sort((a, b) => score(a) - score(b))[0] || current;
          setGpuFocused(next.id);
          setManualCameraOverride(true);
          void flow.setCenter(next.position.x + (next.width || 220) / 2,
            next.position.y + (next.height || 264) / 2,
            { zoom: Math.min(1, Math.max(PERSON_FOCUS_ZOOM, camera.zoom)), duration: 0 });
        }}
        onPointerDownCapture={(event) => {
          if (gpuActive) {
            gpuPressPerson.current = (event.target as Element).closest(".react-flow__pane")
              ? gpuPersonAt(event.clientX, event.clientY)?.data.person.id || "" : "";
            if (gpuPressPerson.current) gpuLongPress.handlers.onPointerDown(event);
            else gpuLongPress.cancel();
          } else gpuLongPress.cancel();
          edgePan.onPointerDownCapture(event);
          middleAnchor.onPointerDownCapture(event);
        }}
        onMouseDownCapture={middleAnchor.onMouseDownCapture}
        onAuxClickCapture={middleAnchor.onAuxClickCapture}
        onClickCapture={(event) => {
          edgePan.onClickCapture(event);
          if (gpuLongPress.suppressClick.current) {
            gpuLongPress.suppressClick.current = false;
            // Only the long press's canvas click is suppressed. Toolbar actions
            // also remain reachable through keyboard activation after a hold.
            if ((event.target as Element).closest(".react-flow__pane")) {
              event.preventDefault(); event.stopPropagation();
            }
          }
        }}
        tabIndex={gpuActive ? 0 : -1}
        aria-busy={growthPreparing || growthActive}
        onContextMenu={(event) => {
          if (growthActive || layoutBusy) {
            event.preventDefault();
            return;
          }
          const target = event.target as Element;
          if (gpuActive && gpuPersonAt(event.clientX, event.clientY)) { event.preventDefault(); return; }
          if (target.closest(".flow-person")) {
            event.preventDefault();
            return;
          }
          if (narrow || (!props.onExport && !props.onImport) || !target.closest(".react-flow__pane")) return;
          event.preventDefault();
          const bounds = container.current?.getBoundingClientRect();
          if (!bounds) return;
          setContextMenu({
            x: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 205)),
            y: Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - (props.onImport ? 110 : 70))),
          });
        }}
        aria-label="Полотно древа. Для выхода из полного экрана дважды коснитесь фона или нажмите Назад."
      >
        <div className="tree-mode-bar">
          {narrow ? (
            <button
              type="button"
              className="tree-mode-switch"
              role="switch"
              aria-label="Древо / Хронология"
              aria-checked={timelineActive}
              disabled={growthLocked || layoutBusy}
              title={activeFanAnchor || timelineActive ? "Переключить на древо" : "Переключить на хронологию"}
              onClick={() => switchMode(activeFanAnchor || timelineActive ? "generations" : "timeline")}
            >
              {timelineActive ? (
                <ChartNoAxesGantt size={18} aria-hidden="true" />
              ) : (
                <TreeDeciduous size={18} aria-hidden="true" />
              )}
              <span>{timelineActive ? "Хронология" : "Древо"}</span>
              <ArrowLeftRight size={14} aria-hidden="true" />
            </button>
          ) : (
            <div className="segmented" aria-label="Представление дерева">
              <button
                aria-pressed={!activeFanAnchor && mode === "generations"}
                disabled={growthLocked || layoutBusy}
                onClick={() => switchMode("generations")}
              >
                Древо
              </button>
              <button
                aria-pressed={timelineActive}
                disabled={growthLocked || layoutBusy}
                onClick={() => switchMode("timeline")}
              >
                Хронология
              </button>
            </div>
          )}
          {!narrow && (
            <ArchiveSummary people={family.people} busy={layoutBusy} />
          )}
          {!!family.links?.length && (
            <button
              className="tree-extra-toggle"
              aria-label="Доп. связи"
              aria-pressed={extraVisible}
              disabled={growthLocked || layoutBusy}
              onClick={() => setExtraVisible((v) => !v)}
              title="Крёстные, усыновление, опека и другие дополнительные связи"
            >
              {narrow && <Link2 size={19} aria-hidden="true" />}
              <span>Доп. связи</span>
            </button>
          )}
          {narrow && props.comparisonAction}
          {props.assistantFilter && (
            <div
              className="tree-family-tools tree-filter-status"
              role="status"
              title={`${props.assistantFilter.label}: ${visible.size} из ${family.people.length}`}
            >
              <span className="tree-family-count">
                {props.assistantFilter.label}: {visible.size} из{" "}
                {family.people.length}
              </span>
              <button
                type="button"
                aria-label="Всё древо"
                title="Сбросить фильтр и показать всё древо"
                onClick={() => {
                  props.onClearAssistantFilter?.();
                  familyView.showAll();
                }}
              >
                {narrow ? <RotateCcw size={19} aria-hidden="true" /> : "Всё древо"}
              </button>
            </div>
          )}
          {family.people.length > 0 &&
            !props.restricted &&
            !props.assistantFilter && (
            <FamilyViewTools
              compact={narrow}
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
                setFanRevealing(false);
                props.onClearAssistantFilter?.();
                rememberContext();
                clearReturnTarget();
                fanEntry.current = null;
                setFanAnchor(null);
                familyView.enter();
              }}
              onCommon={() => {
                setFanRevealing(false);
                props.onClearAssistantFilter?.();
                rememberContext();
                clearReturnTarget();
                fanEntry.current = null;
                setFanAnchor(null);
                familyView.enterCommon();
              }}
              onFan={() => {
                const next = selected[0] || root || familyView.defaultAnchor;
                if (!next) return;
                const reduced = window.matchMedia(
                  "(prefers-reduced-motion: reduce)",
                ).matches;
                fanMorphSources.current = !reduced && container.current
                  ? captureFanMorphSources(container.current, family, next)
                  : [];
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
                setFanRevealing(false);
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
          {narrow && preferencesAction}
        </div>
        {!narrow && (props.comparisonAction || preferencesAction) && (
          <div className="tree-display-actions">
            {props.comparisonAction}
            {preferencesAction}
          </div>
        )}
        {activeFanAnchor ? (
          <FanChart
            family={family}
            anchorId={activeFanAnchor}
            selected={selected}
            onChoose={actions.choose}
          />
        ) : (
          <ReactFlow<PersonNodeType | HouseholdNodeType, RelationshipEdgeType>
          proOptions={{ hideAttribution: true }}
            nodes={mode === "timeline" ? emptyFlowNodes : flowNodes}
            edges={mode === "timeline" ? emptyFlowEdges : flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionMode={ConnectionMode.Loose}
          onConnectStart={() => setConnecting(true)}
          onConnect={connect}
          onConnectEnd={(event, state) => {
            setConnecting(false);
            if (
              !props.canEdit ||
              props.allowDragConnect === false ||
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
                twinKind: edge.data.connection.twinKind,
                sources: edge.data.connection.sources,
                confidence: edge.data.connection.confidence,
              });
          }}
          onReconnectStart={() => setConnecting(true)}
          onReconnectEnd={() => setConnecting(false)}
          onEdgeClick={(_, e) => {
            if (e.data) e.data.onSelect(e.data.connection);
          }}
          onPaneClick={(event) => {
            if (distantScene || gpuActive) {
              const bounds = container.current?.getBoundingClientRect();
              const hit = bounds && hitDistantScene(nodes, displayEdges,
                flow.getViewport(), {
                  x: event.clientX - bounds.left,
                  y: event.clientY - bounds.top,
                });
              if (hit?.node) {
                actions.choose(hit.node.data.person.id, event.shiftKey);
                return;
              }
              if (hit?.edge?.data) {
                hit.edge.data.onSelect(hit.edge.data.connection);
                return;
              }
            }
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
          nodesConnectable={
            props.canEdit && props.allowDragConnect !== false && !props.busy
          }
          nodesFocusable={false}
          edgesReconnectable={
            props.canEdit && props.allowDragConnect !== false && !props.busy
          }
          deleteKeyCode={null}
          panOnScroll={!cameraLocked}
          zoomOnScroll={false}
          zoomOnPinch={!cameraLocked}
          zoomOnDoubleClick={!cameraLocked && !screen.fullscreen}
          selectionKeyCode={null}
          selectionOnDrag={false}
          panOnDrag={cameraLocked ? false : [0, 1]}
          minZoom={0.05}
          maxZoom={1.8}
          // Culling uses final coordinates, not the CSS-interpolated position.
          // Small views keep moving nodes mounted across the viewport edge.
          // Large transitions keep DOM work bounded to the current viewport.
          onlyRenderVisibleElements={
            gpuActive || distantScene || family.people.length >= 500 || renderedNodes.length >= 500 || (
              !layoutSettling && (!growing || displayNodes.length > 500) &&
              !(distantZoom && displayNodes.length <= 2000)
            )
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
            <TreeCameraTools selected={selected} disabled={cameraLocked} fitTree={fitTree}
              onFocusSelected={() => { void focusSelected(); }} />
          )}
        </ReactFlow>
        )}
        {gpuEligible && (
          <TreeGpuScene key={gpuScope}
            visible={gpuActive}
            nodes={nodes} edges={gpuEdges} households={overviewHouseholds} width={canvasWidth} height={canvasHeight}
            hovered={gpuHovered} focused={gpuFocused} relationLabel={actions.relationLabel}
            onReady={gpuReady} onFailure={gpuFailure} />
        )}
        {!activeFanAnchor && mode !== "timeline" && !gpuActive && (
          <DistantPortraits
            people={portraitPeople}
            nodes={nodes}
            households={overviewHouseholds}
            edges={canvasEdges}
            fullScene={overviewAvailable || progressiveCanvasIntro}
            width={canvasWidth}
            height={canvasHeight}
            growing={growing}
            growthStarted={growthStarted}
            growthDelays={growthDelays}
          />
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
            focus={effectiveTimelineFocus}
            onChoose={actions.choose}
          />
        )}
        {anchorNotice && !problem && (
          <div className="tree-notice" role="status">
            {anchorNotice}
          </div>
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
              <div className="flow-empty-actions">
                {props.onAddSelf && (
                  <button className="primary-action" onClick={props.onAddSelf}>
                    <Plus size={18} />
                    Добавить себя
                  </button>
                )}
                <button
                  className={props.onAddSelf ? "flow-empty-secondary" : "primary-action"}
                  onClick={props.onAdd}
                >
                  <Plus size={18} />
                  Добавить первого человека
                </button>
                {props.onRename && (
                  <button className="flow-empty-rename" onClick={props.onRename}>
                    Назвать дерево
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {contextMenu && !narrow && (
          <div className="tree-context-menu" role="menu" aria-label="Действия с древом"
            style={{ left: contextMenu.x, top: contextMenu.y }}>
              {props.onExport && <button type="button" role="menuitem" onClick={() => {
                props.onExport?.();
                setContextMenu(null);
              }}>
                <Download size={16} aria-hidden="true" /> Экспорт древа
              </button>}
              {props.onImport && <button type="button" role="menuitem" onClick={() => {
                props.onImport?.();
                setContextMenu(null);
              }}>
                <Upload size={16} aria-hidden="true" /> Импорт
              </button>}
          </div>
        )}
      </div>
    </TreeActions.Provider>
  );
});
export const TreeCanvas = memo(function TreeCanvas({
  ref,
  ...props
}: Props & { ref?: Ref<TreeCanvasHandle> }) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} ref={ref} />
    </ReactFlowProvider>
  );
});
