import {
  createReadStream,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer as createViteServer } from "vite";

const [databasePath, uploadsPath, outputPath, browserPath] =
  process.argv.slice(2);
if (!databasePath || !uploadsPath || !outputPath || !browserPath)
  throw new Error(
    "Usage: browser-face-backfill <database.sqlite> <uploads-dir> <result.json> <browser.exe>",
  );

const db = new DatabaseSync(databasePath, { readOnly: true });
const manifest = (() => {
  try {
    const photos = db
      .prepare("SELECT id,data FROM photos ORDER BY rowid")
      .all();
    const tags = db
      .prepare("SELECT photo_id,data FROM photo_tags ORDER BY rowid")
      .all();
    const byPhoto = new Map<string, unknown[]>();
    for (const row of tags) {
      const photoId = String(row.photo_id);
      const list = byPhoto.get(photoId) || [];
      list.push(JSON.parse(String(row.data)));
      byPhoto.set(photoId, list);
    }
    return photos.flatMap((row) => {
      const photo = JSON.parse(String(row.data)) as { url?: unknown };
      const file = typeof photo.url === "string" ? basename(photo.url) : "";
      const photoTags = byPhoto.get(String(row.id)) || [];
      return file && photoTags.length && existsSync(resolve(uploadsPath, file))
        ? [{ id: String(row.id), file, tags: photoTags }]
        : [];
    });
  } finally {
    db.close();
  }
})();

const vite = await createViteServer({
  root: resolve("."),
  configFile: resolve("vite.config.ts"),
  server: { middlewareMode: true },
  appType: "custom",
});
const profile = mkdtempSync(join(tmpdir(), "drevo-face-browser-"));
let browser: ReturnType<typeof spawn> | undefined;
const result = await new Promise<unknown>((done, reject) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/__face_backfill") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Face backfill</title><script type="module" src="/src/vision/face-backfill-page.ts"></script>',
      );
      return;
    }
    if (url.pathname === "/__face_backfill/manifest") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (url.pathname.startsWith("/__face_backfill/uploads/")) {
      const file = decodeURIComponent(
        url.pathname.slice("/__face_backfill/uploads/".length),
      );
      if (file !== basename(file)) {
        res.writeHead(400).end();
        return;
      }
      const path = resolve(uploadsPath, file);
      if (!existsSync(path)) {
        res.writeHead(404).end();
        return;
      }
      const mime = new Map([
        [".jpg", "image/jpeg"],
        [".png", "image/png"],
        [".webp", "image/webp"],
        [".gif", "image/gif"],
      ]).get(extname(path).toLowerCase());
      res.writeHead(200, {
        "Content-Type": mime || "application/octet-stream",
      });
      createReadStream(path).pipe(res);
      return;
    }
    if (url.pathname === "/__face_backfill/result" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200).end("ok");
      done(value);
      server.close();
      return;
    }
    vite.middlewares(req, res, () => {
      res.writeHead(404).end();
    });
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    browser = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${port}/__face_backfill`,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    browser.once("error", reject);
  });
});

const payload = result as { descriptors?: unknown; report?: unknown };
if (!Array.isArray(payload.descriptors))
  throw new Error("Browser backfill did not return descriptors");
writeFileSync(outputPath, JSON.stringify(payload.descriptors), { mode: 0o600 });
browser?.kill();
await vite.close();
rmSync(profile, { recursive: true, force: true });
console.log(JSON.stringify(payload.report));
