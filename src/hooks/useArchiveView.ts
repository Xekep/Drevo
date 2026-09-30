import { useCallback, useEffect, useRef, useState } from "react";
import {
  archivePaths,
  archiveViewAt,
  type ArchiveView,
} from "../domain/archive-routes";
import { archiveTargetPath, type ArchiveTarget } from "../domain/archive-links";
import { scopedArchivePath } from "../domain/archive-context.ts";

export function useArchiveView(canLeave: () => boolean = () => true) {
  const currentUrl = useRef(window.location.pathname + window.location.search);
  const [view, update] = useState<ArchiveView>(
    () => archiveViewAt(window.location.pathname) || "tree",
  );
  const [currentPath, updatePath] = useState(
    () => window.location.pathname + window.location.search,
  );
  const navigate = useCallback(
    (next: ArchiveView, target?: ArchiveTarget | string, replace = false) => {
      const path = scopedArchivePath(
        typeof target === "string"
          ? target
          : target
            ? archiveTargetPath(target)
            : archivePaths[next],
      );
      const fullscreen = Boolean(window.history.state?.drevoTreeFullscreen);
      if (window.location.pathname + window.location.search !== path)
        window.history[replace || fullscreen ? "replaceState" : "pushState"](
          fullscreen ? window.history.state : null,
          "",
          path,
        );
      currentUrl.current = path;
      updatePath(path);
      update(next);
    },
    [],
  );
  useEffect(() => {
    const sync = () => {
      if (!canLeave()) {
        window.history.pushState(null, "", currentUrl.current);
        return;
      }
      currentUrl.current = window.location.pathname + window.location.search;
      updatePath(currentUrl.current);
      update(archiveViewAt(window.location.pathname) || "tree");
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [canLeave]);
  return [view, navigate, currentPath] as const;
}
