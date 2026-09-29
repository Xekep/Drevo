import { useEffect, useMemo, useRef, useState } from "react";
import type { Family } from "../../domain/types";
import type { TreeGeometry, TreeMode } from "../../domain/tree-layout";
import { MAX_INCREMENTAL_LAYOUT_PEOPLE } from "../../domain/tree-layout-constants";
import { projectTree } from "../../domain/family-neighborhood";
import type { TaggedLayoutWorkerResponse } from "./layout-worker-protocol";
import type { LayoutWorkerRequest } from "./layout-worker-protocol";
import { createLayoutMemoryCache, layoutCacheKey } from "./layout-cache";
import { readLayout, writeLayout } from "./layout-storage";

export function useTreeLayout(
  family: Family,
  visible: ReadonlySet<string>,
  mode: TreeMode,
  reverse: boolean,
  cacheScope: string | null = null,
) {
  const { people, links } = family;
  // Выделение человека, фотография и текстовая правка не перезапускают геометрию,
  // если состав видимой семейной проекции остался прежним.
  const projected = useMemo(
    () => projectTree({ people, links }, visible),
    [people, links, visible],
  );
  const key = useMemo(
    () => layoutCacheKey({ ...projected, mode, reverse }),
    [projected, mode, reverse],
  );
  // Stabilize by content, not React object identity. Preserve the input order
  // because ELK's model-order constraint is part of the layout contract.
  const input = useMemo(
    () => (JSON.parse(key) as { input: LayoutWorkerRequest }).input,
    [key],
  );
  const layoutVisible = useMemo(
    () => new Set(input.people.map((p) => p.id)),
    [input],
  );
  const cache = useMemo(() => {
    // A different account/access policy owns a different in-memory cache.
    void cacheScope;
    return createLayoutMemoryCache();
  }, [cacheScope]);
  const [result, setResult] = useState<{
    key: string;
    geometry: TreeGeometry | null;
    visible: ReadonlySet<string>;
    error: string;
    scope: string | null;
  }>({ key: "", geometry: null, visible, error: "", scope: cacheScope });
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const pendingRef = useRef(false);
  const lastGeometryRef = useRef<{
    key: string;
    scope: string | null;
    geometry: TreeGeometry;
  } | null>(null);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      pendingRef.current = false;
    },
    [],
  );

  useEffect(() => {
    // Свободный worker переиспользуем. Если предыдущий ELK ещё считает уже
    // устаревшую геометрию, terminate дешевле, чем разрешать двум layout идти
    // параллельно и конкурировать за CPU.
    if (pendingRef.current && workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
      pendingRef.current = false;
    }
    const requestId = ++requestRef.current;
    const last = lastGeometryRef.current;
    const previousGeometry =
      mode === "generations" &&
      input.people.length <= MAX_INCREMENTAL_LAYOUT_PEOPLE &&
      last !== null &&
      last.scope === cacheScope &&
      last.key !== key &&
      last.geometry.mode === mode &&
      last.geometry.reverse === reverse &&
      last.geometry.positions.length <= 300
        ? {
            nodeSize: last.geometry.nodeSize,
            mode: last.geometry.mode,
            reverse: last.geometry.reverse,
            start: last.geometry.start,
            offset: last.geometry.offset,
            positions: last.geometry.positions,
            occurrences: last.geometry.occurrences,
          }
        : undefined;
    let cancelled = false;
    let detach = () => {};
    const timer = setTimeout(() => {
      if (requestRef.current === requestId) setBusy(true);
    }, 80);
    const finish = (data: TaggedLayoutWorkerResponse) => {
      if (
        cancelled ||
        data.requestId !== requestId ||
        requestRef.current !== requestId
      )
        return;
      clearTimeout(timer);
      pendingRef.current = false;
      setBusy(false);
      if (!("error" in data))
        lastGeometryRef.current = { key, scope: cacheScope, geometry: data.geometry };
      setResult((previous) =>
        "error" in data
          ? {
              ...previous,
              key,
              error: data.error,
              scope: cacheScope,
              geometry:
                previous.scope === cacheScope ? previous.geometry : null,
            }
          : {
              key,
              geometry: data.geometry,
              visible: layoutVisible,
              error: "",
              scope: cacheScope,
            },
      );
    };
    const calculate = () => {
      if (cancelled) return;
      try {
        const worker =
          workerRef.current ||
          new Worker(new URL("./layout.worker.ts", import.meta.url), {
            type: "module",
          });
        workerRef.current = worker;
        pendingRef.current = true;
        const onMessage = (event: MessageEvent<TaggedLayoutWorkerResponse>) => {
          const data = event.data;
          if (cancelled || data.requestId !== requestId) return;
          if (!("error" in data)) {
            cache.set(key, data.geometry);
            if (cacheScope) void writeLayout(cacheScope, key, data.geometry);
          }
          finish(data);
        };
        const onError = () => {
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          finish({
            requestId,
            error:
              "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.",
          });
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        detach = () => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
        };
        worker.postMessage({ requestId, ...input, previousGeometry });
      } catch {
        finish({
          requestId,
          error:
            "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.",
        });
      }
    };
    const cached = cache.get(key);
    if (cached) finish({ requestId, geometry: cached });
    else if (cacheScope) {
      void readLayout(cacheScope, key).then((geometry) => {
        if (cancelled) return;
        if (geometry) {
          cache.set(key, geometry);
          finish({ requestId, geometry });
        } else calculate();
      });
    } else calculate();

    return () => {
      clearTimeout(timer);
      cancelled = true;
      detach();
    };
  }, [key, input, layoutVisible, cache, cacheScope, mode, reverse]);

  const sameScope = result.scope === cacheScope;
  return {
    geometry: sameScope ? result.geometry : null,
    renderVisible: sameScope && result.geometry ? result.visible : visible,
    ready: sameScope && result.key === key && !result.error,
    problem: sameScope && result.key === key ? result.error : "",
    layoutBusy: busy,
    layoutKey: key,
  };
}
