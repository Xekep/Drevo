import { useEffect, useRef } from "react";
import type { EChartsOption, EChartsType } from "echarts";

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

  useEffect(() => {
    let active = true;
    let observer: ResizeObserver | undefined;
    void import("./echarts-runtime").then(({ echarts }) => {
      if (!active || !element.current) return;
      const instance = echarts.init(element.current, undefined, {
        renderer: "canvas",
      });
      chart.current = instance;
      instance.setOption(latest.current, { notMerge: true });
      observer = new ResizeObserver(() => instance.resize());
      observer.observe(element.current);
      ready.current?.(instance);
    });
    return () => {
      active = false;
      observer?.disconnect();
      ready.current?.(null);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    latest.current = option;
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  useEffect(() => {
    ready.current = onReady;
  }, [onReady]);

  return <div ref={element} className={className} role="img" aria-label={label} />;
}
