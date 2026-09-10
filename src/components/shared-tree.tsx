import { useEffect, useMemo, useState } from "react";
import { ArrowDownUp, Clock3 } from "lucide-react";
import type { Family } from "../domain/types";
import { analyzeKinship } from "../domain/kinship";
import { TreeCanvas } from "./tree/tree-canvas";
import { InspectorDock } from "./inspector-dock";
import { PersonInspector } from "./person-inspector";
import { ComparisonPanel } from "./comparison-panel";
import { useWorkspaceSelection } from "../hooks/useWorkspaceSelection";
const noop = () => {};
type SharedData = {
  family: Family;
  expiresAt: string;
  serverTime: string;
  reverseTimeline: boolean;
};
export default function SharedTree({ token }: { token: string }) {
  const [data, setData] = useState<SharedData | null>(null),
    [error, setError] = useState("");
  const { selected, compare, choose, reveal, dispatch, focus } =
    useWorkspaceSelection();
  useEffect(() => {
    const referrer = document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    document.head.append(referrer);
    const controller = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    const unavailable = (message: string) => {
      setData(null);
      setError(message);
    };
    const refresh = async () => {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const r = await fetch(`/api/shared/${token}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const result = await r.json();
        if (!r.ok) {
          unavailable(result.error || "Ссылка недоступна");
          return;
        }
        const remaining =
          Date.parse(result.expiresAt) - Date.parse(result.serverTime);
        if (remaining <= 0) {
          unavailable("Срок действия ссылки истёк.");
          return;
        }
        setData(result);
        setError("");
        clearTimeout(expiry);
        expiry = setTimeout(
          () => unavailable("Срок действия ссылки истёк."),
          Math.min(remaining, 2147483647),
        );
      } catch {
        if (!controller.signal.aborted)
          unavailable("Не удалось проверить доступ. Обновите страницу.");
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearInterval(timer);
      clearTimeout(expiry);
      document.removeEventListener("visibilitychange", visible);
      referrer.remove();
    };
  }, [token]);
  const chosen = useMemo(
    () =>
      selected.flatMap(
        (id) => data?.family.people.find((p) => p.id === id) || [],
      ),
    [data, selected],
  );
  const relation = useMemo(
    () =>
      chosen.length === 2 && data
        ? analyzeKinship(
            chosen[0],
            chosen[1],
            data.family.people,
            data.family.links,
          )
        : null,
    [chosen, data],
  );
  return (
    <div className="archive-app shared-app">
      <div className="archive-main">
        <header className="shared-header">
          <img src="/favicon.svg" alt="" />
          <div>
            <strong>{data?.family.title || "Семейное древо"}</strong>
            {data && (
              <small>
                <Clock3 size={13} />
                Доступ до {new Date(data.expiresAt).toLocaleString("ru-RU")}
              </small>
            )}
          </div>
        </header>
        {data ? (
          <main className="archive-workspace is-tree">
            <div className="tree-view">
              <TreeCanvas
                restricted
                family={data.family}
                user={null}
                canEdit={false}
                busy={false}
                reverse={data.reverseTimeline}
                selected={selected}
                onChoose={choose}
                onEdge={(edge) => reveal([edge.from, edge.to])}
                onConnect={noop}
                onClear={() => dispatch({ type: "clear" })}
                onAdd={noop}
                onAddRelative={noop}
                onLink={noop}
                focus={focus}
                preview={null}
                query=""
                highlighted={relation?.path || []}
              />
              <div className="workspace-actions">
                <button
                  className={compare ? "active" : ""}
                  onClick={() => dispatch({ type: "compare" })}
                >
                  <ArrowDownUp size={17} />
                  Родство
                </button>
              </div>
              {(compare || chosen.length > 0) && (
                <InspectorDock
                  key={compare ? `comparison:${chosen.length}` : chosen[0]?.id}
                  onClose={() => dispatch({ type: "clear" })}
                >
                  {compare ? (
                    <ComparisonPanel
                      selected={chosen}
                      relation={relation}
                      people={data.family.people}
                      links={data.family.links}
                      onRemove={(id) => choose(id, true)}
                      onReveal={() => reveal(relation?.path || selected)}
                    />
                  ) : (
                    chosen[0] && (
                      <PersonInspector
                        key={chosen[0].id}
                        person={chosen[0]}
                        family={data.family}
                        user={null}
                        canEdit={false}
                        readPhotos={false}
                        onEdit={noop}
                        onNewRelative={noop}
                        onExistingRelative={noop}
                        onAlbum={noop}
                        onSelect={(id) => reveal([id])}
                        onCompare={() => dispatch({ type: "compare" })}
                      />
                    )
                  )}
                </InspectorDock>
              )}
            </div>
          </main>
        ) : (
          <main className="archive-status">
            <h1>{error ? "Ссылка недоступна" : "Открываем семью…"}</h1>
            {error && <p role="alert">{error}</p>}
          </main>
        )}
      </div>
    </div>
  );
}
