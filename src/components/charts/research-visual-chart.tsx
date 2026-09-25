import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, X } from "lucide-react";
import type { EChartsOption, EChartsType } from "echarts";
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

function visualOption(visual: ResearchVisual, expanded: boolean): EChartsOption {
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
        layout: "force",
        roam: true,
        draggable: true,
        force: {
          repulsion: visual.graph.nodes.length > 50 ? 170 : expanded ? 520 : 300,
          edgeLength: expanded ? 190 : 110,
          friction: 0.65,
          initLayout: "circular",
        },
        data: visual.graph.nodes.map((node) => ({
          id: node.id,
          name: node.label || node.name,
          symbolSize: expanded ? 25 : 20,
          itemStyle: { color: "#5f8766", borderColor: "#fff", borderWidth: 2 },
        })),
        links: visual.graph.edges.map((edge) => ({
          source: edge.from,
          target: edge.to,
          name: edge.label ||
            (edge.type === "parent"
              ? "родитель → ребёнок"
              : edge.type === "spouse"
                ? "супруги"
                : "дополнительная связь"),
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
          show: expanded && visual.graph.edges.length <= 30,
          color: "#657b65",
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
  const visual = parsed.visual;
  const inlineOption = useMemo(
    () => (visual ? visualOption(visual, false) : {}),
    [visual],
  );
  const expandedOption = useMemo(
    () => (visual ? visualOption(visual, true) : {}),
    [visual],
  );

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  if (!visual) return <p className="research-visual-error">{parsed.error}</p>;
  const label = visualLabel(visual);
  return (
    <>
      {!expanded && (
        <div className="research-visual">
          <ChartCanvas
            option={inlineOption}
            className="research-visual-plot"
            label={label}
          />
          <button
            type="button"
            className="research-visual-expand"
            onClick={() => setExpanded(true)}
            aria-label="Развернуть схему"
            title="Развернуть схему"
          >
            <span aria-hidden="true">⛶</span>
          </button>
        </div>
      )}
      {expanded &&
        createPortal(
          <div
            className="research-visual-overlay"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setExpanded(false);
            }}
          >
            <section
              className="research-visual-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={visual.kind === "graph" ? "Схема родства" : "Диаграмма"}
            >
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
          </div>,
          document.body,
        )}
    </>
  );
}
