/** Keep cold kinship searches and text shaping out of the first GPU frame. */
export function scheduleGpuLabelPreparation(
  count: number,
  prepare: (index: number) => void,
  complete: () => void,
  failed: () => void,
) {
  let cancelled = false, index = 0;
  let timer: ReturnType<typeof setTimeout>;
  const step = () => {
    if (cancelled) return;
    const started = performance.now();
    let processed = 0;
    try {
      // A single search is indivisible, but never accumulate the whole graph
      // into one task. The item cap also bounds cheap, already cached labels.
      while (index < count && processed < 32 &&
        (processed === 0 || performance.now() - started < 4)) {
        prepare(index++);
        processed++;
        if (cancelled) return;
      }
      if (index === count) complete();
      else timer = setTimeout(step, 1);
    } catch {
      if (!cancelled) failed();
    }
  };
  timer = setTimeout(step, 1);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
