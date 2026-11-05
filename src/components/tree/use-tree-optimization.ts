import { useCallback, useEffect, useRef, useState } from "react";
import type { Family } from "../../domain/types";
import type { TreeGeometry } from "../../domain/tree-layout";
import { projectTree } from "../../domain/family-neighborhood";
import type { LayoutWorkerRequest, TaggedLayoutWorkerResponse } from "./layout-worker-protocol";
import type { TreeOptimizationGoal } from "../../domain/optimize-tree-layout";

/** Owns an explicit local refinement. A changed graph/access scope cancels it. */
export function useTreeOptimization(
  original: TreeGeometry | null, key: string, family: Family,
  visible: ReadonlySet<string>, ready: boolean,
) {
  const [result, setResult] = useState<{ original: TreeGeometry; key: string; geometry: TreeGeometry; token: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const job = useRef<{ cancel: () => void } | null>(null);
  const token = useRef(0);
  useEffect(() => () => { job.current?.cancel(); }, [original, key]);
  const current = result?.original === original && result?.key === key ? result : null;
  const geometry = current?.geometry || original;
  const optimize = useCallback(async (goal: TreeOptimizationGoal = "routing", displayed = geometry, recalculate = false) => {
    if (!ready || !original || !displayed) throw new Error("Дождитесь отрисовки древа.");
    job.current?.cancel();
    const operation = recalculate ? "Пересчёт" : "Оптимизация";
    const failure = recalculate ? "Не удалось пересчитать расположение." : "Не удалось оптимизировать расположение.";
    const requestId = ++token.current;
    const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    setBusy(true);
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (message: string, error = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        if (job.current === owner) job.current = null;
        setBusy(false);
        if (error) reject(new Error(message)); else resolve(message);
      };
      const owner = { cancel: () => finish("Раскладка изменилась; расчёт отменён.", true) };
      job.current = owner;
      const timer = setTimeout(() => finish(`${operation} занял${recalculate ? "" : "а"} слишком долго. Выберите меньший фрагмент.`, true), recalculate ? 60_000 : 30_000);
      worker.onmessage = (event: MessageEvent<TaggedLayoutWorkerResponse>) => {
        if (settled) return;
        const data = event.data;
        if (data.requestId !== requestId) return;
        if ("error" in data || (!recalculate && !data.optimization)) {
          finish("error" in data ? data.error : failure, true);
          return;
        }
        if (recalculate || data.optimization?.changed)
          setResult({ original, key, geometry: data.geometry, token: requestId });
        if (recalculate) {
          finish("Расположение пересчитано с учётом текущих фильтров и свёрнутых ветвей.");
          return;
        }
        const optimization = data.optimization!;
        finish(goal === "compact" ? (optimization.changed
          ? "Древо уплотнено."
          : "Уплотнить расположение без ухудшения основных связей не удалось.") : optimization.changed
          ? `Расположение обновлено. Пересечения основных связей: ${optimization.before.crossings} → ${optimization.after.crossings}.`
          : "Дополнительного улучшения без ухудшения основных связей не найдено.");
      };
      worker.onerror = () => finish(failure, true);
      const request: LayoutWorkerRequest = { requestId, ...projectTree(family, visible),
        mode: "generations", reverse: displayed.reverse,
        ...(recalculate ? {} : { previousGeometry: displayed, optimizeDisplayed: true, layoutGoal: goal }) };
      try { worker.postMessage(request); }
      catch { finish("Не удалось передать раскладку для оптимизации.", true); }
    });
  }, [ready, original, key, geometry, family, visible]);
  const recalculate = useCallback(() => optimize("routing", geometry, true), [optimize, geometry]);
  return { geometry, optimize, recalculate, busy, layoutKey: current ? `${key}:optimized:${current.token}` : key };
}
