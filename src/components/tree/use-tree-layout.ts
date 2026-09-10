import { useEffect, useMemo, useRef, useState } from "react";
import type { Family } from "../../domain/types";
import type { TreeGeometry, TreeMode } from "../../domain/tree-layout";
import { projectTree } from "../../domain/family-neighborhood";
import type { TaggedLayoutWorkerResponse } from "./layout-worker-protocol";

export function useTreeLayout(
  family: Family,
  visible: ReadonlySet<string>,
  mode: TreeMode,
  reverse: boolean,
) {
  const { people, links } = family;
  // Выбор карточки, фотография и текстовая правка не перезапускают геометрию,
  // если состав видимой семейной проекции остался прежним.
  const key = useMemo(
    () =>
      JSON.stringify({
        ...projectTree({ people, links }, visible),
        mode,
        reverse,
      }),
    [people, links, visible, mode, reverse],
  );
  const [result, setResult] = useState<{
    key: string;
    geometry: TreeGeometry | null;
    error: string;
  }>({ key: "", geometry: null, error: "" });
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const worker =
      workerRef.current ||
      new Worker(new URL("./layout.worker.ts", import.meta.url), {
        type: "module",
      });
    workerRef.current = worker;

    const requestId = ++requestRef.current;
    const timer = setTimeout(() => {
      if (requestRef.current === requestId) setBusy(true);
    }, 80);
    const finish = (data: TaggedLayoutWorkerResponse) => {
      if (data.requestId !== requestId || requestRef.current !== requestId)
        return;
      clearTimeout(timer);
      setBusy(false);
      setResult((previous) =>
        "error" in data
          ? { key, geometry: previous.geometry, error: data.error }
          : { key, geometry: data.geometry, error: "" },
      );
    };

    worker.onmessage = (event: MessageEvent<TaggedLayoutWorkerResponse>) =>
      finish(event.data);
    worker.onerror = () =>
      finish({
        requestId,
        error:
          "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.",
      });
    worker.postMessage({ requestId, ...JSON.parse(key) });

    return () => {
      clearTimeout(timer);
      if (requestRef.current === requestId) setBusy(false);
    };
  }, [key]);

  return {
    geometry: result.geometry,
    ready: result.key === key && !result.error,
    problem: result.key === key ? result.error : "",
    layoutBusy: busy,
    layoutKey: key,
  };
}
