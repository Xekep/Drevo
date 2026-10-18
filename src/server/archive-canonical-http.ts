import type { IncomingMessage, ServerResponse } from "node:http";
import { archiveContextAt } from "../domain/archive-context.ts";
import { archiveViewAt } from "../domain/archive-routes.ts";

/** Keep old page bookmarks working without exposing the primary archive's ID. */
export function archiveCanonicalHttp(primaryArchiveId?: string) {
  return (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const context = archiveContextAt(url.pathname);
    const target =
      primaryArchiveId &&
      context?.id === primaryArchiveId &&
      (archiveViewAt(url.pathname) ||
        /^\/s\/[A-Za-z0-9_-]{43}$/.test(context.innerPath))
        ? /^\/admin\/?$/.test(context.innerPath)
          ? "/manage"
          : context.innerPath
        : null;
    if (!target) return false;
    res.writeHead(308, {
      Location: target + url.search,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    });
    res.end();
    return true;
  };
}
