import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { ChartCanvas } from "./chart-canvas";

type DayUsage = {
  day: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  models: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
};

const format = (value: number) => value.toLocaleString("ru-RU");
const dateLabel = (day: string, options?: Intl.DateTimeFormatOptions) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("ru-RU", {
    timeZone: "UTC",
    ...options,
  });

export function AiTokenUsageChart({ history }: { history: DayUsage[] }) {
  const option = useMemo<EChartsOption>(
    () => ({
      animation: true,
      animationDuration: 300,
      grid: { left: 48, right: 12, top: 16, bottom: 34 },
      tooltip: {
        trigger: "axis",
        renderMode: "richText",
        confine: true,
        axisPointer: { type: "shadow" },
        formatter: (params: unknown) => {
          const row = Array.isArray(params) ? params[0] : params;
          const index = Number((row as { dataIndex?: number })?.dataIndex);
          const day = history[index];
          if (!day) return "";
          return [
            dateLabel(day.day),
            `Всего: ${format(day.totalTokens)}`,
            `Вход: ${format(day.inputTokens)} · выход: ${format(day.outputTokens)}`,
            ...day.models.map(
              (model) =>
                `${model.model.replace(/^gpt:\/\/[^/]+\//, "")}: ${format(model.inputTokens)} / ${format(model.outputTokens)}`,
            ),
          ].join("\n");
        },
      },
      xAxis: {
        type: "category",
        data: history.map((day) =>
          dateLabel(day.day, { day: "2-digit", month: "2-digit" }),
        ),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "#dce4d8" } },
        axisLabel: { color: "#71806f", fontSize: 11, interval: 1 },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLabel: { color: "#71806f", fontSize: 11 },
        splitLine: { lineStyle: { color: "#edf1ea" } },
      },
      series: [
        {
          name: "Вход",
          type: "bar",
          stack: "tokens",
          barMaxWidth: 24,
          itemStyle: { color: "#4f7658" },
          data: history.map((day) => day.inputTokens),
        },
        {
          name: "Выход",
          type: "bar",
          stack: "tokens",
          barMaxWidth: 24,
          itemStyle: { color: "#a9c19c", borderRadius: [4, 4, 0, 0] },
          data: history.map((day) => day.outputTokens),
        },
      ],
    }),
    [history],
  );
  return (
    <ChartCanvas
      option={option}
      className="ai-token-plot"
      label={`Расход токенов за последние 14 дней. ${history
        .map((day) => `${dateLabel(day.day)}: ${format(day.totalTokens)}`)
        .join("; ")}`}
    />
  );
}
