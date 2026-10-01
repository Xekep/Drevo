import { useCallback, useEffect, useRef, useState } from "react";
import { archiveResourceUrl } from "../../domain/archive-context.ts";

export function useDiscussionCount(personId: string, enabled: boolean) {
  const url = archiveResourceUrl(
    `/api/people/${encodeURIComponent(personId)}/discussion?count=1`,
  );
  const [result, setResult] = useState<{ url: string; total: number } | null>(
    null,
  );
  const serial = useRef(0);
  const update = useCallback(
    (total: number) => {
      serial.current += 1;
      setResult({ url, total });
    },
    [url],
  );
  useEffect(() => {
    if (!enabled) return;
    const request = ++serial.current;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { total?: number }) : null,
      )
      .then((data) => {
        if (
          !controller.signal.aborted &&
          request === serial.current &&
          Number.isSafeInteger(data?.total)
        )
          setResult({ url, total: data!.total! });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [url, enabled]);
  return { count: result?.url === url ? result.total : null, update };
}
