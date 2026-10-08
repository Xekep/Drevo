import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, useCallback, type ReactNode } from "react";
import { archiveResourceUrl } from "../../domain/archive-context.ts";
import { TreePublicationStatuses } from "./tree-publication-statuses.ts";

const PublicationStatuses = createContext<TreePublicationStatuses | null>(null);

export function TreePublicationProvider({ enabled, scope, update, children }: {
  enabled: boolean;
  scope: string;
  update?: { personId: string; published: boolean } | null;
  children: ReactNode;
}) {
  const endpoint = archiveResourceUrl("/api/admin/published-people/batch");
  const statuses = useMemo(() => {
    // Reset only the private cache when access changes; retain the canvas subtree.
    void scope;
    return enabled
      ? new TreePublicationStatuses(endpoint, (input, init) => fetch(input, init)) : null;
  }, [enabled, endpoint, scope]);
  useEffect(() => {
    statuses?.start();
    return () => statuses?.stop();
  }, [statuses]);
  useEffect(() => {
    if (update) statuses?.update(update.personId, update.published);
  }, [statuses, update]);
  return <PublicationStatuses.Provider value={statuses}>{children}</PublicationStatuses.Provider>;
}

export function useTreePublicationStatus(id: string, visible: boolean) {
  const statuses = useContext(PublicationStatuses);
  const subscribe = useCallback((listener: () => void) =>
    statuses && visible ? statuses.subscribe(id, listener) : () => {}, [statuses, id, visible]);
  const get = useCallback(() => statuses?.get(id) || "unknown", [statuses, id]);
  const status = useSyncExternalStore(subscribe, get, get);
  return { status, refresh: () => statuses?.refresh(id) };
}
