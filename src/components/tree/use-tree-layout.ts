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
  const projected = useMemo(
    () => projectTree({ people, links }, visible),
    [people, links, visible],
  );
  const key = useMemo(
    () => JSON.stringify({ ...projected, mode, reverse }),
    [projected, mode, reverse],
  );
  const [result, setResult] = useState<{
    key: string;
    geometry: TreeGeometry | null;
    visible: ReadonlySet<string>;
    error: string;
  }>({ key: "", geometry: null, visible, error: "" });
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  const pendingRef = useRef(false);

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
    const worker =
      workerRef.current ||
      new Worker(new URL("./layout.worker.ts", import.meta.url), {
        type: "module",
      });
    workerRef.current = worker;

    const requestId = ++requestRef.current;
    pendingRef.current = true;
    const timer = setTimeout(() => {
      if (requestRef.current === requestId) setBusy(true);
    }, 80);
    const finish = (data: TaggedLayoutWorkerResponse) => {
      if (data.requestId !== requestId || requestRef.current !== requestId)
        return;
      clearTimeout(timer);
      pendingRef.current = false;
      setBusy(false);
      setResult((previous) =>
        "error" in data
          ? { ...previous, key, error: data.error }
          : { key, geometry: data.geometry, visible, error: "" },
      );
    };
    const onMessage = (event: MessageEvent<TaggedLayoutWorkerResponse>) =>
      finish(event.data);
    const onError = () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      pendingRef.current = false;
      finish({
        requestId,
        error:
          "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.",
      });
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ requestId, ...projected, mode, reverse });

    return () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
  }, [key, projected, mode, reverse, visible]);

  return {
    geometry: result.geometry,
    renderVisible: result.geometry ? result.visible : visible,
    ready: result.key === key && !result.error,
    problem: result.key === key ? result.error : "",
    layoutBusy: busy,
    layoutKey: key,
  };
}
