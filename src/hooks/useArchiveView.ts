import { useCallback, useEffect, useState } from "react";
import {
  archivePaths,
  archiveViewAt,
  type ArchiveView,
} from "../domain/archive-routes";

export function useArchiveView() {
  const [view, update] = useState<ArchiveView>(
    () => archiveViewAt(window.location.pathname) || "tree",
  );
  const navigate = useCallback((next: ArchiveView) => {
    const path = archivePaths[next];
    if (window.location.pathname !== path)
      window.history.pushState(null, "", path);
    update(next);
  }, []);
  useEffect(() => {
    const sync = () =>
      update(archiveViewAt(window.location.pathname) || "tree");
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return [view, navigate] as const;
}
