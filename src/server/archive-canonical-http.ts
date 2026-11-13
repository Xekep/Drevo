import type { IncomingMessage, ServerResponse } from "node:http";
import { archiveContextAt } from "../domain/archive-context.ts";
import { archiveViewAt } from "../domain/archive-routes.ts";
import { notFoundHtml } from "../shared/not-found-page.ts";

/** Reject retired primary-archive aliases; current links already use root paths. */
export function archiveCanonicalHttp(primaryArchiveId?: string) {
  return (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const context = archiveContextAt(url.pathname);
    const retired =
      primaryArchiveId &&
      context?.id === primaryArchiveId &&
      (archiveViewAt(url.pathname, url.search) || /^\/admin\/?$/.test(context.innerPath) ||
        /^\/s\/[A-Za-z0-9_-]{43}$/.test(context.innerPath));
    if (!retired) return false;
    res.writeHead(404, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    });
    res.end(req.method === "HEAD" ? undefined : notFoundHtml);
    return true;
  };
}
