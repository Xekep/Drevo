import type { IncomingMessage, ServerResponse } from "node:http";
import { open as openFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const assetTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
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

/**
 * Отдаёт только Vite assets. Остальная статика остаётся у обычного SPA fallback.
 * Файлы открываются асинхронно и не буферизуются целиком в event loop.
 */
export function staticAssetsHttp(assetDirectory: string) {
  const root = resolve(assetDirectory);

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (!url.pathname.startsWith("/assets/")) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: "Метод не поддерживается" }));
      return true;
    }

    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname.slice("/assets/".length));
    } catch {
      res.writeHead(404, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: "Файл не найден" }));
      return true;
    }
    if (!relative || relative.includes("\0")) return false;

    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) {
      res.writeHead(403, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: "Недоступный путь" }));
      return true;
    }

    let handle;
    try {
      handle = await openFile(path, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return false;
      }
      res.writeHead(200, {
        "Content-Type": assetTypes[extname(path).toLowerCase()] || "application/octet-stream",
        "Content-Length": String(stat.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=31536000, immutable",
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
      return false;
    }
  };
}
