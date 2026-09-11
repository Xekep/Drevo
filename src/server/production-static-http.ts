import type { IncomingMessage, ServerResponse } from "node:http";
import { open as openFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { archiveViewAt } from "../domain/archive-routes.ts";
import { staticAssetsHttp } from "./static-assets-http.ts";

const defaultDistDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist",
);

const staticTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function jsonError(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error }));
  return true;
}

/**
 * Production static fallback без синхронного дискового I/O.
 * Dev-запросы остаются у Vite, а /assets сохраняет отдельный быстрый handler.
 */
export function productionStaticHttp(
  distDirectory = defaultDistDirectory,
  enabled = process.env.NODE_ENV === "production",
) {
  const root = resolve(distDirectory);
  const serveAsset = staticAssetsHttp(resolve(root, "assets"));

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (await serveAsset(req, res, url)) return true;
    if (!enabled) return false;
    const pathname = url.pathname;
    if (pathname.startsWith("/api/") || pathname.startsWith("/auth/"))
      return false;
    if (req.method !== "GET" && req.method !== "HEAD")
      return jsonError(res, 405, "Метод не поддерживается");

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return jsonError(res, 404, "Страница не найдена");
    }
    if (decoded.includes("\0")) return jsonError(res, 404, "Страница не найдена");

    const shared = /^\/s\/[A-Za-z0-9_-]{43}$/.test(pathname);
    const filePath =
      archiveViewAt(pathname) || shared
        ? resolve(root, "index.html")
        : resolve(root, "." + decoded);
    if (
      filePath !== root &&
      !filePath.startsWith(root + sep)
    )
      return jsonError(res, 403, "Недоступный путь");

    let handle;
    try {
      handle = await openFile(filePath, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return jsonError(res, 404, "Страница не найдена");
      }
      if (shared) {
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      }
      res.writeHead(200, {
        "Content-Type":
          staticTypes[extname(filePath).toLowerCase()] ||
          "application/octet-stream",
        "Content-Length": String(stat.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      if (req.method === "HEAD") {
        await handle.close();
        res.end();
        return true;
      }
      try {
        await pipeline(handle.createReadStream(), res);
      } catch {
        if (!res.destroyed) res.destroy();
      }
      return true;
    } catch {
      if (handle) await handle.close().catch(() => {});
      if (res.headersSent) {
        if (!res.destroyed) res.destroy();
        return true;
      }
      return jsonError(res, 404, "Страница не найдена");
    }
  };
}
