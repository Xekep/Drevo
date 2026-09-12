import { useCallback, useEffect, useState } from "react";
import {
  archivePaths,
  archiveViewAt,
  type ArchiveView,
} from "../domain/archive-routes";

export function useArchiveView(canLeave: () => boolean = () => true) {
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
    let currentPath = window.location.pathname;
    const sync = () => {
      if (!canLeave()) {
        window.history.pushState(null, "", currentPath);
        return;
      }
      currentPath = window.location.pathname;
      update(archiveViewAt(currentPath) || "tree");
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [canLeave]);
  return [view, navigate] as const;
}
