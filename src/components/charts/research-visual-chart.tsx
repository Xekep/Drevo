import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, X } from "lucide-react";
import type { EChartsOption, EChartsType } from "echarts";
import type { ElkNode } from "elkjs";
import { useResearchGraphLayout } from "./use-research-graph-layout";
import {
  parseResearchMermaid,
  type ResearchVisual,
} from "../../domain/research-visual.ts";
import { ChartCanvas } from "./chart-canvas";

const colors = [
  "#4f7658",
  "#7fa17e",
  "#b4c794",
  "#bf9c68",
  "#7899a6",
  "#a9829e",
  "#bc8276",
];

function graphSpan(layout?: ElkNode) {
  const points = layout?.children || [];
  const xs = points.map((node) => (node.x || 0) + 70);
  const ys = points.map((node) => (node.y || 0) + 40);
  return {
    x: points.length ? Math.max(2, Math.max(...xs) - Math.min(...xs)) : 2,
    y: points.length ? Math.max(2, Math.max(...ys) - Math.min(...ys)) : 2,
  };
}

function graphEdgeName(edge: { label?: string; type: string }) {
  return edge.label || (edge.type === "parent" ? "родитель → ребёнок"
    : edge.type === "spouse" ? "супруги" : "дополнительная связь");
}

function graphLabelScale(visual: ResearchVisual, expanded: boolean, layout?: ElkNode) {
  if (visual.kind !== "graph" || !layout?.children?.length) return 0;
  const context = document.createElement("canvas").getContext("2d")!;
  const font = expanded ? 12 : 10, maxWidth = expanded ? 160 : 110;
  context.font = `${font}px sans-serif`;
  const positions = new Map(layout.children.map((node) => [node.id, node]));
  const labels = visual.graph.nodes.map((node) => {
    const lines = (node.label || node.name).split("\n");
    const widths = lines.map((line) => context.measureText(line).width);
    return { id: node.id, x: positions.get(node.id)?.x || 0, y: positions.get(node.id)?.y || 0,
      width: Math.min(maxWidth, Math.max(...widths)),
      height: widths.reduce((rows, width) => rows + Math.max(1, Math.ceil(width / maxWidth)), 0) * (font + 2) };
  });
  let scale = 0;
  for (let i = 0; i < labels.length; i++) for (const other of labels.slice(i + 1)) {
    const node = labels[i];
    if (node.y === other.y && node.x !== other.x)
      scale = Math.max(scale, ((node.width + other.width) / 2 + 12) / Math.abs(node.x - other.x));
  }
  context.font = "10px sans-serif";
  for (const edge of visual.graph.edges) {
    const from = labels.find((node) => node.id === edge.from), to = labels.find((node) => node.id === edge.to);
    if (!from || !to) continue;
    const dx = Math.abs(from.x - to.x), dy = Math.abs(from.y - to.y);
    if (!dy || dy < dx) continue;
    const upper = from.y < to.y ? from : to;
    const edgeHeight = (context.measureText(graphEdgeName(edge)).width + 8) *
      dy / Math.hypot(dx, dy) + 14 * dx / Math.hypot(dx, dy);
    scale = Math.max(scale, 2 * (20 + upper.height + edgeHeight / 2 + 12) / dy);
  }
  return scale;
}

function visualOption(visual: ResearchVisual, expanded: boolean, layout?: ElkNode,
  viewport?: { width: number; height: number }): EChartsOption {
  const base: EChartsOption = {
    color: colors,
    animationDuration: 350,
    tooltip: { trigger: "item", renderMode: "richText", confine: true },
  };
  if (visual.kind === "pie")
    return {
      ...base,
      series: [
        {
          type: "pie",
          radius: ["34%", "68%"],
          center: ["50%", "50%"],
          data: visual.values.map((item) => ({
            name: item.label,
            value: item.value,
          })),
          label: { show: expanded, overflow: "truncate" },
          itemStyle: { borderColor: "#fff", borderWidth: 2 },
          emphasis: { scaleSize: 6 },
        },
      ],
    };
  if (visual.kind === "chart")
    return {
      ...base,
      grid: { left: 48, right: 20, top: 28, bottom: 44 },
      tooltip: {
        trigger: "axis",
        renderMode: "richText",
        confine: true,
        axisPointer: { type: "shadow" },
      },
      xAxis: {
        type: "category",
        data: visual.labels,
        axisLabel: { color: "#71806f", hideOverlap: true },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "#dce4d8" } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#71806f" },
        splitLine: { lineStyle: { color: "#edf1ea" } },
      },
      series: [
        {
          type: visual.series,
          data: visual.values,
          itemStyle: { color: "#4f7658", borderRadius: [4, 4, 0, 0] },
          ...(visual.series === "line"
            ? { smooth: true, symbolSize: 7, lineStyle: { width: 3 } }
            : { barMaxWidth: 36 }),
        },
      ],
    };

  const names = new Map(
    visual.graph.nodes.map((node) => [node.id, node.name]),
  );
  const positions = new Map(layout?.children?.map((node) => [node.id, node]));
  const span = graphSpan(layout);
  const horizontalMargin = expanded ? 190 : 140;
  const fitScale = viewport
    ? Math.min(Math.max(1, viewport.width - horizontalMargin) / span.x,
      Math.max(1, viewport.height - 96) / span.y) : 1;
  return {
    ...base,
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (param: unknown) => {
        const item = param as {
          dataType?: string;
          data?: { source?: string; target?: string; name?: string };
        };
        if (item.dataType === "edge")
          return `${names.get(item.data?.source || "") || item.data?.source} → ${names.get(item.data?.target || "") || item.data?.target}\n${item.data?.name || "Связь"}`;
        return item.data?.name || "";
      },
    },
    series: [
      {
        type: "graph",
        layout: "none",
        preserveAspect: "contain",
        // ECharts fits node centres, while text keeps its pixel size. Retain
        // ELK's label clearance; large graphs can be panned instead of crushing it.
        zoom: Math.max(1, graphLabelScale(visual, expanded, layout) / fitScale),
        left: expanded ? 95 : 70,
        right: expanded ? 95 : 70,
        top: 48,
        bottom: 48,
        roam: true,
        draggable: true,
        data: visual.graph.nodes.map((node) => ({
          id: node.id,
          name: node.label || node.name,
          x: (positions.get(node.id)?.x || 0) + 70,
          y: (positions.get(node.id)?.y || 0) + 40,
          symbolSize: expanded ? 25 : 20,
          itemStyle: { color: "#5f8766", borderColor: "#fff", borderWidth: 2 },
        })),
        links: visual.graph.edges.map((edge) => ({
          source: edge.from,
          target: edge.to,
          name: graphEdgeName(edge),
          symbol: ["none", edge.type === "spouse" ? "none" : "arrow"],
          symbolSize: [0, 9],
          lineStyle: {
            type: edge.type === "parent" ? "solid" : "dashed",
            color: edge.type === "parent" ? "#8da68d" : "#b39b7e",
          },
        })),
        lineStyle: { width: 1.5, curveness: 0.08 },
        label: {
          show: true,
          position: "bottom",
          color: "#324637",
          fontSize: expanded ? 12 : 10,
          width: expanded ? 160 : 110,
          overflow: "break",
        },
        edgeLabel: {
          show: (expanded || visual.graph.edges.length <= 12) && visual.graph.edges.length <= 30,
          color: "#455b45",
          opacity: 1,
          backgroundColor: "#fbfcf9",
          padding: [2, 4],
          fontSize: 10,
          formatter: (param: unknown) =>
            String((param as { data?: { name?: string } }).data?.name || ""),
        },
        emphasis: { focus: "adjacency" },
      },
    ],
  };
}

function visualLabel(visual: ResearchVisual) {
  if (visual.kind === "graph") {
    const names = new Map(visual.graph.nodes.map((node) => [node.id, node.name]));
    return `Схема родства: ${visual.graph.nodes.map((node) => node.name).join(", ")}. ${visual.graph.edges.map((edge) => `${names.get(edge.from) || edge.from} — ${names.get(edge.to) || edge.to}: ${edge.label || edge.type}`).join("; ")}`;
  }
  if (visual.kind === "pie")
    return `${visual.title}: ${visual.values.map((item) => `${item.label} ${item.value}`).join(", ")}`;
  return `${visual.title}: ${visual.labels.map((label, index) => `${label} ${visual.values[index]}`).join(", ")}`;
}

export function ResearchVisualChart({ source }: { source: string }) {
  const parsed = useMemo(() => {
    try {
      return { visual: parseResearchMermaid(source), error: "" };
    } catch {
      return { visual: null, error: "Не удалось построить диаграмму" };
    }
  }, [source]);
  const [expanded, setExpanded] = useState(false);
  const chart = useRef<EChartsType | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const inlineFrame = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number }>();
  const closeButton = useRef<HTMLButtonElement>(null);
  const visual = parsed.visual;
  const graphLayout = useResearchGraphLayout(visual?.kind === "graph" ? visual.graph : undefined);
  const inlineHeight = useMemo(() => visual?.kind === "graph"
    ? Math.min(480, Math.max(290,
      graphSpan(graphLayout?.layout).y * graphLabelScale(visual, false, graphLayout?.layout) + 96)) : undefined,
  [visual, graphLayout]);
  const inlineOption = useMemo(
    () => (visual ? visualOption(visual, false, graphLayout?.layout, !expanded ? viewport : undefined) : {}),
    [visual, graphLayout, viewport, expanded],
  );
  const expandedOption = useMemo(
    () => (visual ? visualOption(visual, true, graphLayout?.layout, expanded ? viewport : undefined) : {}),
    [visual, graphLayout, viewport, expanded],
  );

  useEffect(() => {
    if (!expanded) return;
    const modal = dialog.current!;
    const initiator = expandButton.current;
    // Native modality makes the background inert and traps keyboard focus.
    // Keep the initiating button mounted so focus has a destination on close.
    modal.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      modal.close();
      initiator?.focus({ preventScroll: true });
      chart.current = null;
    };
  }, [expanded]);

  useEffect(() => {
    if (visual?.kind !== "graph" || !graphLayout?.layout) return;
    const plot = expanded
      ? dialog.current?.querySelector<HTMLElement>(".research-visual-dialog-plot")
      : inlineFrame.current;
    if (!plot) return;
    const measure = () => {
      const width = plot.clientWidth, height = plot.clientHeight;
      if (width && height) setViewport((previous) =>
        previous?.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    return () => observer.disconnect();
  }, [expanded, visual, graphLayout]);

  if (!visual) return <p className="research-visual-error">{parsed.error}</p>;
  if (visual.kind === "graph" && !graphLayout?.layout)
    return <p role="status" className="research-visual-error">{graphLayout?.error || "Готовлю схему…"}</p>;
  const label = visualLabel(visual);
  return (
    <>
      <div ref={inlineFrame} className="research-visual" hidden={expanded}
        style={inlineHeight ? { height: inlineHeight } : undefined}>
          <ChartCanvas
            option={inlineOption}
            className="research-visual-plot"
            label={label}
          />
          <button
          ref={expandButton}
          type="button"
            className="research-visual-expand"
            onClick={() => setExpanded(true)}
            aria-label="Развернуть схему"
            title="Развернуть схему"
          >
            <span aria-hidden="true">⛶</span>
          </button>
        </div>
      {expanded &&
        createPortal(
          // Native dialog handles clicks on its own backdrop only.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <dialog
            ref={dialog}
            className="research-visual-overlay"
            aria-label={visual.kind === "graph" ? "Схема родства" : "Диаграмма"}
            onCancel={(event) => {
              event.preventDefault();
              setExpanded(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
                ),
              ].filter((element) => element.getClientRects().length > 0);
              if (!items.length) return;
              event.preventDefault();
              const index = items.indexOf(
                document.activeElement as HTMLElement,
              );
              items[
                (index + (event.shiftKey ? -1 : 1) + items.length) %
                  items.length
              ].focus({ preventScroll: true });
            }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setExpanded(false);
            }}
          >
            <section
              className="research-visual-dialog">
              <header>
                <strong>
                  {visual.kind === "graph" ? "Схема родства" : visual.title}
                </strong>
                <div className="research-visual-controls">
                  {visual.kind === "graph" && (
                    <>
                      <button
                        type="button"
                        aria-label="Уменьшить схему"
                        onClick={() =>
                          chart.current?.dispatchAction({
                            type: "graphRoam",
                            seriesIndex: 0,
                            zoom: 0.8,
                          })
                        }
                      >
                        <Minus size={18} />
                      </button>
                      <button
                        type="button"
                        aria-label="Увеличить схему"
                        onClick={() =>
                          chart.current?.dispatchAction({
                            type: "graphRoam",
                            seriesIndex: 0,
                            zoom: 1.25,
                          })
                        }
                      >
                        <Plus size={18} />
                      </button>
                    </>
                  )}
                  <button
                    ref={closeButton}
                    type="button"
                    aria-label="Закрыть схему"
                    onClick={() => setExpanded(false)}
                  >
                    <X size={19} />
                  </button>
                </div>
              </header>
              <ChartCanvas
                option={expandedOption}
                className="research-visual-dialog-plot"
                label={label}
                onReady={(instance) => {
                  chart.current = instance;
                }}
              />
            </section>
          </dialog>,
          document.body,
        )}
    </>
  );
}
