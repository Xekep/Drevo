import { enforceUserStorageLimit } from "./storage-limits.ts";
import { randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  rmSync,
} from "node:fs";
import { stat, statfs, mkdtemp, rm, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { ConflictError, type openArchive } from "./database.ts";
import { exportGedcom } from "../domain/gedcom.ts";
import { TRANSFER_PACKAGE_LIMIT } from "../domain/genealogy-transfer.ts";
import { writeDatabaseBackup } from "./backup.ts";
import { fullName } from "../domain/dates.ts";
import type { Family } from "../domain/types.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import {
  exportMedia,
  prepareGenealogyImport,
  writeGenealogyPackage,
  installTransferFiles,
  type StagedMedia,
} from "./genealogy-package.ts";
import { uploadQuota, UploadQuotaError } from "./upload-quota.ts";
import { mediaStore } from "./media.ts";
import { recordMediaOriginal } from "./media-originals.ts";
import { enforcePostgresMediaQuota } from "./postgres-media-quota.ts";
import { documentSearchText } from "../shared/document-details.ts";

export function gedcomHttp(
  archive: Awaited<ReturnType<typeof openArchive>>,
  auth: Awaited<ReturnType<typeof createAuth>>,
  dbPath: string,
  publicOrigin?: string,
) {
  type Stage = {
    family: Family;
    files: StagedMedia[];
    actor: string;
    revision: number;
    expires: number;
  };
  const stageRoot = join(dirname(dbPath), "staging", "genealogy"),
    uploads = join(dirname(dbPath), "uploads");
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(uploads, { recursive: true });
  const quota = uploadQuota(archive.db);
  let exporting = false;
  const stagePath = (token: string) => {
    if (!/^[a-f0-9-]{36}$/.test(token))
      throw new Error("Некорректный токен импорта");
    return join(stageRoot, token);
  };
  const removeStage = async (token: string) => {
    rmSync(stagePath(token), { force: true, recursive: true });
    await archive.db
      .prepare(
        "DELETE FROM workflow_stages WHERE kind='gedcom' AND token=?",
        "DELETE FROM workflow_stages WHERE kind='gedcom' AND token=?",
      )
      .run(token);
  };
  const clean = async () => {
    for (const row of await archive.db
      .prepare(
        "SELECT token FROM workflow_stages WHERE kind='gedcom' AND expires_at<=?",
        "SELECT token FROM workflow_stages WHERE kind='gedcom' AND expires_at<=?",
      )
      .all(Date.now())) {
      try {
        await removeStage(String(row.token));
      } catch {
        /* Retry on next sweep. */
      }
    }
    for (const entry of await readdir(stageRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^export-[A-Za-z0-9]{6}$/.test(entry.name))
        continue;
      const directory = join(stageRoot, entry.name);
      try {
        if ((await stat(directory)).mtimeMs < Date.now() - 24 * 60 * 60_000)
          await rm(directory, { recursive: true, force: true });
      } catch {
        // Another process may have removed the temporary export already.
      }
    }
  };
  const getStage = async (token: string): Promise<Stage | undefined> => {
    const row = await archive.db
      .prepare(
        "SELECT actor_id,revision,expires_at,data FROM workflow_stages WHERE kind='gedcom' AND token=?",
        "SELECT actor_id,revision,expires_at,data FROM workflow_stages WHERE kind='gedcom' AND token=?",
      )
      .get(token);
    if (!row) return undefined;
    const data = JSON.parse(String(row.data));
    if (data.pending) return undefined;
    return {
      family: data.family || data,
      files: data.files || [],
      actor: String(row.actor_id),
      revision: Number(row.revision),
      expires: Number(row.expires_at),
    };
  };
  let cleaning: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (cleaning) return;
    cleaning = clean()
      .catch(() => {
        console.warn("gedcom_stage_cleanup_failed");
      })
      .finally(() => {
        cleaning = undefined;
      });
  }, 60000);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
      await cleaning;
    },
    async handle(
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
    ): Promise<boolean> {
      if (!url.pathname.startsWith("/api/gedcom/")) return false;
      const json = (status: number, data: unknown) => {
        if (res.destroyed) return true;
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(data));
        return true;
      };
      const actor = await auth.currentUser(req);
      if (!actor || actor.role !== "admin")
        return json(actor ? 403 : 401, {
          error: "Перенос данных доступен администратору",
        });
      try {
        if (url.pathname === "/api/gedcom/export" && req.method === "GET") {
          const format = url.searchParams.get("format") || "gedzip7";
          if (!["gedcom551", "gedcom7", "gedzip7"].includes(format))
            return json(400, { error: "Неизвестный формат экспорта" });
          const family = (await archive.read()).family,
            items = await exportMedia(archive.db, family);
          if (format === "gedzip7") {
            if (exporting)
              return json(429, { error: "Другой экспорт уже выполняется" });
            exporting = true;
            try {
              const disk = await statfs(stageRoot);
              if (
                disk.bavail * disk.bsize <
                TRANSFER_PACKAGE_LIMIT + 256 * 1024 ** 2
              )
                throw new UploadQuotaError(
                  "Недостаточно места для экспорта",
                  507,
                );
              const directory = await mkdtemp(join(stageRoot, "export-"));
              try {
                const path = join(directory, "export.gdz");
                await writeGenealogyPackage(path, uploads, family, items);
                if ((await auth.currentUser(req))?.role !== "admin")
                  return json(403, { error: "Доступ администратора отозван" });
                res.writeHead(200, {
                  "Content-Type": "application/zip",
                  "Content-Length": String((await stat(path)).size),
                  "Content-Disposition": 'attachment; filename="drevo.gdz"',
                  "Cache-Control": "no-store",
                  "X-Content-Type-Options": "nosniff",
                });
                await pipeline(createReadStream(path), res);
                return true;
              } finally {
                await rm(directory, { recursive: true, force: true });
              }
            } finally {
              exporting = false;
            }
          }
          const text = exportGedcom(family, {
            version: format === "gedcom551" ? "5.5.1" : "7.0",
            media: items,
          });
          res.writeHead(200, {
            "Content-Type": "text/vnd.familysearch.gedcom; charset=utf-8",
            "Content-Disposition": `attachment; filename="${format === "gedcom551" ? "drevo-5.5.1.ged" : "drevo-7.ged"}"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(text);
          return true;
        }
        if (
          req.method !== "POST" ||
          !["/api/gedcom/preview", "/api/gedcom/import"].includes(url.pathname)
        )
          return json(405, { error: "Метод не поддерживается" });
        if (!isSameOriginRequest(req, publicOrigin))
          return json(403, { error: "Недопустимый источник запроса" });
        if (req.headers["x-drevo-import"] !== "1")
          return json(400, { error: "Откройте импорт в админке" });
        await clean();
        if (url.pathname.endsWith("preview")) {
          const token = randomUUID(),
            directory = stagePath(token),
            current = await archive.read();
          const old = await archive.db
            .prepare(
              "SELECT token FROM workflow_stages WHERE kind='gedcom' AND actor_id=?",
              "SELECT token FROM workflow_stages WHERE kind='gedcom' AND actor_id=?",
            )
            .all(actor.id);
          for (const row of old) await removeStage(String(row.token));
          const inserted = await archive.db
            .prepare(
              "INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data) SELECT ?,'gedcom',?,?,?,? WHERE (SELECT count(*) FROM workflow_stages WHERE kind='gedcom')<3",
              "INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data) SELECT ?,'gedcom',?,?,?,? WHERE (SELECT count(*) FROM workflow_stages WHERE kind='gedcom')<3",
            )
            .run(
              token,
              actor.id,
              current.revision,
              Date.now() + 15 * 60000,
              JSON.stringify({ pending: true }),
            );
          if (!inserted.changes)
            return json(429, {
              error: "Уже проверяется несколько импортов. Повторите позже.",
            });
          mkdirSync(directory, { recursive: true });
          let success = false;
          try {
            const disk = await statfs(directory);
            if (disk.bavail * disk.bsize < 3 * TRANSFER_PACKAGE_LIMIT)
              throw new UploadQuotaError(
                "Недостаточно места для предпросмотра",
                507,
              );
            const input = join(directory, "input");
            let size = 0;
            const guard = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                size += chunk.length;
                if (size > TRANSFER_PACKAGE_LIMIT)
                  return callback(
                    new Error("Максимальный размер пакета — 512 МиБ"),
                  );
                callback(null, chunk);
              },
            });
            await pipeline(
              req,
              guard,
              createWriteStream(input, { flags: "wx" }),
              { signal: AbortSignal.timeout(15 * 60_000) },
            );
            const parsed = await prepareGenealogyImport(
              input,
              directory,
              randomUUID(),
            );
            if ((await auth.currentUser(req))?.role !== "admin")
              return json(403, { error: "Доступ администратора отозван" });
            if (
              parsed.family.people.length + current.family.people.length >
              10000
            )
              throw new Error("После импорта получится больше 10 000 людей");
            const updated = await archive.db
              .prepare(
                "UPDATE workflow_stages SET data=? WHERE kind='gedcom' AND token=? AND expires_at>?",
                "UPDATE workflow_stages SET data=? WHERE kind='gedcom' AND token=? AND expires_at>?",
              )
              .run(
                JSON.stringify({ family: parsed.family, files: parsed.files }),
                token,
                Date.now(),
              );
            if (!updated.changes)
              throw new Error(
                "Предпросмотр заменён или истёк. Проверьте файл заново.",
              );
            const existing = new Set(
              current.family.people.map(
                (p) => `${fullName(p).toLocaleLowerCase("ru")}|${p.birth}`,
              ),
            );
            const duplicates = parsed.family.people.filter((p) =>
              existing.has(`${fullName(p).toLocaleLowerCase("ru")}|${p.birth}`),
            );
            success = true;
            return json(200, {
              token,
              revision: current.revision,
              version: parsed.version,
              people: parsed.family.people.length,
              connections:
                parsed.family.people.reduce(
                  (n, p) => n + p.parents.length + p.spouses.length / 2,
                  0,
                ) + (parsed.family.links?.length || 0),
              events: parsed.family.people.reduce(
                (n, p) => n + (p.events?.length || 0),
                0,
              ),
              photos: parsed.family.photos?.length || 0,
              documents: parsed.files.filter((f) => f.documentId).length,
              warnings: parsed.warnings,
              warningCount: parsed.warnings.length,
              possibleDuplicates: duplicates.slice(0, 30).map(fullName),
              duplicateCount: duplicates.length,
              sample: parsed.family.people.slice(0, 20).map((p) => ({
                name: fullName(p),
                birth: p.birth,
                death: p.death,
              })),
            });
          } finally {
            if (!success) await removeStage(token);
          }
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096)
            return json(413, { error: "Слишком большой запрос" });
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const stage =
          typeof body.token === "string"
            ? await getStage(body.token)
            : undefined;
        if (
          body.confirm !== true ||
          !stage ||
          stage.actor !== actor.id ||
          stage.expires <= Date.now()
        )
          return json(400, {
            error: "Проверьте файл и подтвердите импорт заново",
          });
        const current = await archive.read();
        if (stage.revision !== current.revision)
          return json(409, {
            error:
              "Архив изменился после предпросмотра. Проверьте файл заново.",
          });
        const directory = join(dirname(dbPath), "backups");
        mkdirSync(directory, { recursive: true });
        await writeDatabaseBackup(
          archive.db,
          join(directory, `before-gedcom-${Date.now()}-${randomUUID()}.sqlite`),
        );
        let release: (() => unknown) | undefined,
          undo: (() => Promise<void>) | undefined;
        try {
          if (stage.files.length) {
            const usage = await mediaStore(uploads).usage(),
              disk = await statfs(uploads);
            release = await quota.acquire(
              actor.id,
              stage.files.reduce((n, f) => n + f.size, 0),
              disk.bavail * disk.bsize,
              { ...usage, files: usage.files + stage.files.length - 1 },
            );
            undo = await installTransferFiles(
              stagePath(body.token),
              uploads,
              stage.files,
            );
          }
          const currentActor = await auth.currentUser(req);
          if (currentActor?.role !== "admin")
            throw new Error("Доступ администратора отозван");
          const result = await archive.write(
            {
              ...current.family,
              people: [...current.family.people, ...stage.family.people],
              links: [
                ...(current.family.links || []),
                ...(stage.family.links || []),
              ],
              photos: [
                ...(current.family.photos || []),
                ...(stage.family.photos || []),
              ],
            },
            stage.revision,
            currentActor,
            "Импорт GEDCOM / XML",
            undefined,
            undefined,
            async (db) => {
              const consumed = await db
                .prepare(
                  "DELETE FROM workflow_stages WHERE kind='gedcom' AND token=? AND actor_id=? AND expires_at>?",
                  "DELETE FROM workflow_stages WHERE kind='gedcom' AND token=? AND actor_id=? AND expires_at>?",
                )
                .run(body.token, actor.id, Date.now());
              if (!consumed.changes)
                throw new Error("Предпросмотр уже использован или истёк");
              for (const file of stage.files) {
                if (!file.documentId)
                  await recordMediaOriginal(
                    db,
                    `/media/${file.name}`,
                    file.size,
                    actor.id,
                  );
              }
              for (const file of stage.files.filter((f) => f.documentId)) {
                const details = file.document || {
                  documentType: "",
                  documentDate: "",
                  place: "",
                  description: "",
                  provenance: "",
                };
                await db
                  .prepare(
                    "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at,document_type,document_date,place,description,provenance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                  )
                  .run(
                    file.documentId!,
                    file.title,
                    documentSearchText(file.title, details),
                    file.name,
                    file.size,
                    actor.id,
                    new Date().toISOString(),
                    details.documentType,
                    details.documentDate,
                    details.place,
                    details.description,
                    details.provenance,
                  );
                for (const id of file.personIds)
                  await db
                    .prepare(
                      "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
                      "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
                    )
                    .run(file.documentId!, id);
              }
              if (stage.files.length) {
                await enforcePostgresMediaQuota(db);
                await enforceUserStorageLimit(db, actor.id);
              }
            },
          );
          undo = undefined;
          try {
            await removeStage(body.token);
          } catch {
            /* Import has committed. */
          }
          return json(200, {
            revision: result.revision,
            added: stage.family.people.length,
            photos: stage.family.photos?.length || 0,
            documents: stage.files.filter((f) => f.documentId).length,
          });
        } finally {
          await undo?.();
          release?.();
        }
      } catch (error) {
        if (res.headersSent) {
          res.destroy(error as Error);
          return true;
        }
        return json(
          error instanceof ConflictError
            ? 409
            : error instanceof UploadQuotaError
              ? error.status
              : 400,
          { error: (error as Error).message },
        );
      }
    },
  };
}
