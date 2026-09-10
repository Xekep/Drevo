import { useEffect, useMemo, useState } from "react";
import type { Family } from "../../domain/types";
import type { TreeGeometry, TreeMode } from "../../domain/tree-layout";
import { projectTree } from "../../domain/family-neighborhood";

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
  useEffect(() => {
    let active = true;
    const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), {
      type: "module",
    });
    const timer = setTimeout(() => setBusy(true), 80);
    const finish = (data: TreeGeometry | { error: string }) => {
      if (!active) return;
      clearTimeout(timer);
      setBusy(false);
      setResult((previous) =>
        "error" in data
          ? { key, geometry: previous.geometry, error: data.error }
          : { key, geometry: data, error: "" },
      );
    };
    worker.onmessage = (
      event: MessageEvent<TreeGeometry | { error: string }>,
    ) => finish(event.data);
    worker.onerror = () =>
      finish({
        error:
          "Не удалось рассчитать расположение. Переключите представление, чтобы повторить.",
      });
    worker.postMessage(JSON.parse(key));
    return () => {
      active = false;
      clearTimeout(timer);
      worker.terminate();
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
