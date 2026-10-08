const boundaries = [50, 100, 250, 500, 1000, 5000, 30_000] as const;

/** Bounded counters only: no account IDs, URLs, query strings or request bodies. */
export function requestMetrics() {
  const started = Date.now();
  const counts = Array<number>(boundaries.length + 1).fill(0);
  let active = 0,
    completed = 0,
    serverErrors = 0,
    busy = 0,
    disconnected = 0;
  return {
    begin() {
      active++;
      const start = performance.now();
      let done = false;
      return (status: number, ended: boolean) => {
        if (done) return;
        done = true;
        active--;
        completed++;
        if (!ended) disconnected++;
        else if (status >= 500) serverErrors++;
        if (status === 429 || status === 503) busy++;
        const elapsed = performance.now() - start;
        const bucket = boundaries.findIndex((limit) => elapsed <= limit);
        counts[bucket < 0 ? boundaries.length : bucket]++;
      };
    },
    snapshot: () => ({
      since: new Date(started).toISOString(),
      active,
      completed,
      serverErrors,
      busy,
      disconnected,
      durationBuckets: counts.map((count, index) => ({
        maxMs: boundaries[index] ?? null,
        count,
      })),
    }),
  };
}
