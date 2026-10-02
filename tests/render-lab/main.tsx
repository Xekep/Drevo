import { createRoot } from "react-dom/client";
import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  useReactFlow,
  useStore,
  type Viewport,
} from "@xyflow/react";
import { PersonNode } from "../../src/components/tree/person-node";
import { RelationshipEdge } from "../../src/components/tree/relationship-edge";
import { HouseholdNode } from "../../src/components/tree/household-node";
import { DistantPortraits } from "../../src/components/tree/distant-portraits";
import { buildTreeNodeModel } from "../../src/components/tree/tree-node-model";
import { buildTreeEdges } from "../../src/components/tree/tree-edge-adapter";
import { treeGrowthDelays } from "../../src/components/tree/tree-growth";
import {
  archiveConnections,
  type Family,
  type TreeGeometry,
} from "../../src/domain";
import { webglScene } from "./webgl";
import "@xyflow/react/dist/style.css";
import "../../src/styles/app.css";
import "../../src/styles/workspace.css";
import "../../src/styles/tree-workspace.css";
import "../../src/styles/design-refinement.css";

const input = (
  window as typeof window & {
    __labInput: { family: Family; geometry: TreeGeometry };
  }
).__labInput;
const visible = new Set(input.family.people.map((person) => person.id));
const growthDelays = treeGrowthDelays(input.family.people);
const model = buildTreeNodeModel({
  ...input,
  mode: "generations",
  visible,
  selected: [],
  collapsed: new Set(),
  root: null,
  hidden: new Map(),
  expanded: new Set(),
  query: "",
  growthDelays,
});
const edges = buildTreeEdges({
  ...input,
  user: null,
  mode: "generations",
  connections: archiveConnections(input.family),
  visible,
  positions: model.positions,
  occurrencePeople: model.occurrencePeople,
  peopleMap: model.peopleMap,
  highlighted: [],
  canEdit: false,
  busy: false,
  extraVisible: false,
  preview: null,
  onEdge: () => {},
  onChoices: () => {},
  growthDelays,
});
const nodeTypes = { person: PersonNode, household: HouseholdNode },
  edgeTypes = { relationship: RelationshipEdge };
const center = {
  x:
    (Math.min(...model.nodes.map((node) => node.position.x)) +
      Math.max(...model.nodes.map((node) => node.position.x + node.width!))) /
    2,
  y:
    (Math.min(...model.nodes.map((node) => node.position.y)) +
      Math.max(...model.nodes.map((node) => node.position.y + node.height!))) /
    2,
};
const width = innerWidth,
  height = innerHeight;
const cameraAt = (zoom: number): Viewport => ({
  x: width / 2 - center.x * zoom,
  y: height / 2 - center.y * zoom,
  zoom,
});
let setCamera: (camera: Viewport) => void = () => {};
const root = createRoot(document.getElementById("root")!);
let gpu: Awaited<ReturnType<typeof webglScene>> | null = null;
let renderer = "";

function CurrentRenderer() {
  const distant = useStore((state) => state.transform[2] < 0.18);
  const flow = useReactFlow();
  const nodes = useMemo(
    () =>
      distant
        ? model.displayNodes.map((node) => ({ ...node, hidden: true }))
        : model.displayNodes,
    [distant],
  );
  useEffect(() => {
    setCamera = (camera) => {
      void flow.setViewport(camera);
    };
  }, [flow]);
  return (
    <div className="tree-canvas" style={{ width, height, minHeight: 0 }}>
      <ReactFlow
        nodes={nodes}
        edges={distant ? [] : edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultViewport={cameraAt(0.1)}
        minZoom={0.01}
        maxZoom={2}
        onlyRenderVisibleElements
        nodesDraggable={false}
        nodesConnectable={false}
        connectionMode={ConnectionMode.Loose}
      >
        <DistantPortraits
          people={input.family.people}
          nodes={model.nodes}
          households={model.displayNodes.filter(
            (node) => node.type === "household",
          )}
          edges={edges}
          fullScene
          width={width}
          height={height}
          growing={false}
          growthStarted={false}
          growthDelays={growthDelays}
        />
      </ReactFlow>
    </div>
  );
}

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
const lab = {
  cameraAt,
  nodes: model.nodes.length,
  edges: edges.length,
  center,
  landmarks(zoom: number) {
    const camera = cameraAt(zoom);
    return model.nodes
      .map((node) => ({
        x: Math.round(camera.x + (node.position.x + node.width! / 2) * zoom),
        y: Math.round(camera.y + (node.position.y + 70) * zoom),
      }))
      .filter(
        ({ x, y }) => x > 10 && y > 10 && x < width - 10 && y < height - 10,
      )
      .slice(0, 30);
  },
  async mount(mode: "current" | "webgl") {
    renderer = mode;
    if (gpu) {
      gpu.destroy();
      gpu = null;
    }
    root.render(null);
    await settle(100);
    if (mode === "current") {
      root.render(
        <ReactFlowProvider>
          <CurrentRenderer />
        </ReactFlowProvider>,
      );
      await settle(500);
    } else {
      root.render(
        <canvas
          id="gpu-scene"
          width={width * devicePixelRatio}
          height={height * devicePixelRatio}
          style={{ width, height }}
        />,
      );
      await settle(100);
      const canvas = document.getElementById("gpu-scene") as HTMLCanvasElement;
      gpu = await webglScene(canvas, model.nodes, edges);
      setCamera = (camera) => gpu!.draw(camera);
      setCamera(cameraAt(0.1));
    }
  },
  async prepare(zoom: number) {
    setCamera(cameraAt(zoom));
    await settle(1200);
    await Promise.all(
      [...document.images].map((image) => image.decode().catch(() => {})),
    );
    await settle(300);
  },
  async gesture(
    kind: "pan" | "zoom" | "handoff",
    zoom: number,
    duration = 4000,
  ) {
    const gaps: number[] = [],
      longTasks: number[] = [];
    const observer = new PerformanceObserver((entries) =>
      longTasks.push(...entries.getEntries().map((entry) => entry.duration)),
    );
    observer.observe({ type: "longtask" });
    let previous = 0,
      updates = 0;
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        if (previous) gaps.push(now - previous);
        previous = now;
        const elapsed = now - started,
          t = Math.min(1, elapsed / duration);
        const camera =
          kind === "pan"
            ? cameraAt(zoom)
            : cameraAt(
                kind === "handoff"
                  ? 0.17 + 0.06 * Math.sin(Math.PI * t)
                  : zoom * (1 + 0.18 * Math.sin(Math.PI * t)),
              );
        if (kind === "pan") {
          camera.x += 180 * Math.sin(2 * Math.PI * t);
          camera.y += 65 * Math.sin(2 * Math.PI * t);
        }
        setCamera(camera);
        updates++;
        if (elapsed >= duration) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await settle(100);
    observer.disconnect();
    gaps.sort((a, b) => a - b);
    return {
      renderer,
      kind,
      zoom,
      durationMs: Math.round(performance.now() - started),
      updates,
      p50Ms: +gaps[Math.floor(gaps.length * 0.5)].toFixed(1),
      p95Ms: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
      maxMs: +gaps.at(-1)!.toFixed(1),
      over50Ms: gaps.filter((value) => value > 50).length,
      longTasks: longTasks.map(Math.round),
      cards: document.querySelectorAll(".react-flow__node").length,
      paths: document.querySelectorAll(".react-flow__edge").length,
      dom: document.querySelectorAll("*").length,
      gpu: gpu?.stats() || null,
    };
  },
};
Object.assign(window, { __renderLab: lab });
document.body.style.cssText = "margin:0;overflow:hidden;background:#f7f8f4";
// Match a settled scene, excluding entrance animation from the motion measurement.
const style = document.createElement("style");
style.textContent =
  ".tree-grow-node,.tree-grow-surface,.tree-grow-edge-visual,.tree-edge-final-path{animation:none!important;opacity:1!important}.tree-edge-growth-path{display:none}";
document.head.append(style);
