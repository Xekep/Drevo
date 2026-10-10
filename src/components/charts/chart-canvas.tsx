import { useEffect, useRef } from "react";
import type { EChartsOption, EChartsType } from "echarts";

function applyOption(
  instance: EChartsType,
  value: EChartsOption,
  reduced: boolean,
) {
  instance.setOption(
    reduced
      ? {
          ...value,
          animation: false,
          animationDuration: 0,
          animationDurationUpdate: 0,
          series: (Array.isArray(value.series)
            ? value.series
            : value.series
              ? [value.series]
              : []
          ).map((series) => ({ ...series, animation: false })),
        }
      : value,
    { notMerge: true },
  );
}

export function ChartCanvas({
  option,
  className,
  label,
  onReady,
}: {
  option: EChartsOption;
  className: string;
  label: string;
  onReady?: (chart: EChartsType | null) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const latest = useRef(option);
  const ready = useRef(onReady);
  const motion = useRef<MediaQueryList | null>(null);

  useEffect(() => {
    let active = true;
    let observer: ResizeObserver | undefined;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    motion.current = preference;
    const onMotionChange = () => {
      if (chart.current)
        applyOption(chart.current, latest.current, preference.matches);
    };
    preference.addEventListener("change", onMotionChange);
    void import("./echarts-runtime").then(({ echarts }) => {
      if (!active || !element.current) return;
      const instance = echarts.init(element.current, undefined, {
        renderer: "canvas",
      });
      chart.current = instance;
      applyOption(instance, latest.current, preference.matches);
      observer = new ResizeObserver(() => instance.resize());
      observer.observe(element.current);
      ready.current?.(instance);
    });
    return () => {
      active = false;
      preference.removeEventListener("change", onMotionChange);
      observer?.disconnect();
      ready.current?.(null);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    latest.current = option;
    if (chart.current)
      applyOption(chart.current, option, !!motion.current?.matches);
  }, [option]);

  useEffect(() => {
    ready.current = onReady;
  }, [onReady]);

  return (
    <div ref={element} className={className} role="img" aria-label={label} />
  );
}
