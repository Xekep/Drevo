import { useCallback, useEffect, useRef, useState } from "react";
import {
  archivePaths,
  archiveViewAt,
  type ArchiveView,
} from "../domain/archive-routes";
import { archiveTargetPath, type ArchiveTarget } from "../domain/archive-links";
import { scopedArchivePath } from "../domain/archive-context.ts";

function canonicalPath() {
  const path = window.location.pathname
    .replace(/^(\/a\/[A-Za-z0-9-]{3,64})\/admin(?=\/|$)/, "$1/manage")
    .replace(/^\/admin\/matches(?=\/|$)/, "/manage/matches");
  if (path !== window.location.pathname)
    window.history.replaceState(window.history.state, "", path + window.location.search + window.location.hash);
  return path + window.location.search;
}

export function useArchiveView(canLeave: () => boolean = () => true) {
  const [currentPath, updatePath] = useState(canonicalPath);
  const currentUrl = useRef(currentPath);
  const [view, update] = useState<ArchiveView>(
    () => archiveViewAt(window.location.pathname) || "tree",
  );
  const navigate = useCallback(
    (next: ArchiveView, target?: ArchiveTarget | string, replace = false) => {
      if (next === "admin") {
        window.location.assign(archivePaths.admin);
        return;
      }
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
      currentUrl.current = canonicalPath();
      updatePath(currentUrl.current);
      update(archiveViewAt(window.location.pathname) || "tree");
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [canLeave]);
  return [view, navigate, currentPath] as const;
}
