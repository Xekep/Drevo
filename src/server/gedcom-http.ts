import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { ConflictError } from "./database.ts";
import { importGedcom, exportGedcom } from "../domain/gedcom.ts";
import { writeDatabaseBackup } from "./backup.ts";
import { fullName } from "../domain/dates.ts";
import type { Family } from "../domain/types.ts";
import { isSameOriginRequest } from "./same-origin.ts";
export function gedcomHttp(
  archive: ReturnType<typeof openArchive>,
  auth: ReturnType<typeof createAuth>,
  dbPath: string,
  publicOrigin?: string,
) {
  type Stage = { family: Family; actor: string; revision: number; expires: number };
  const clean = () =>
    archive.db
      .prepare("DELETE FROM workflow_stages WHERE kind='gedcom' AND expires_at<=?")
      .run(Date.now());
  const getStage = (token: string): Stage | undefined => {
    const row = archive.db
      .prepare(
        "SELECT actor_id,revision,expires_at,data FROM workflow_stages WHERE kind='gedcom' AND token=?",
      )
      .get(token);
    if (!row) return undefined;
    return {
      family: JSON.parse(String(row.data)),
      actor: String(row.actor_id),
      revision: Number(row.revision),
      expires: Number(row.expires_at),
    };
  };
  const timer = setInterval(clean, 60000);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
    },
    async handle(
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
    ): Promise<boolean> {
      if (!url.pathname.startsWith("/api/gedcom/")) return false;
      const json = (status: number, data: unknown) => {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(data));
        return true;
      };
      const actor = auth.currentUser(req);
      if (!actor || actor.role !== "admin")
        return json(actor ? 403 : 401, {
          error: "GEDCOM доступен администратору",
        });
      if (url.pathname === "/api/gedcom/export" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/vnd.familysearch.gedcom; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Disposition": 'attachment; filename="drevo.ged"',
        });
        res.end(exportGedcom(archive.read().family));
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
        return json(400, { error: "Откройте импорт GEDCOM в админке" });
      try {
        const preview = url.pathname.endsWith("preview"),
          chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > (preview ? 8 * 1024 * 1024 : 4096))
            return json(413, { error: "Максимальный размер GEDCOM — 8 МБ" });
          chunks.push(Buffer.from(chunk));
        }
        const currentActor = auth.currentUser(req);
        if (currentActor?.role !== "admin")
          return json(403, { error: "Доступ администратора отозван" });
        clean();
        const current = archive.read();
        if (preview) {
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            );
          } catch {
            return json(400, { error: "Файл должен быть в кодировке UTF-8" });
          }
          const parsed = importGedcom(text, randomUUID());
          if (
            parsed.family.people.length + current.family.people.length >
            10000
          )
            return json(400, {
              error: "После импорта получится больше 10 000 людей",
            });
          archive.db
            .prepare("DELETE FROM workflow_stages WHERE kind='gedcom' AND actor_id=?")
            .run(actor.id);
          const active = Number(
            archive.db
              .prepare("SELECT count(*) AS count FROM workflow_stages WHERE kind='gedcom'")
              .get()!.count,
          );
          if (active >= 3)
            return json(429, {
              error: "Уже проверяется несколько импортов. Повторите позже.",
            });
          const token = randomUUID();
          archive.db
            .prepare(
              `INSERT INTO workflow_stages(token,kind,actor_id,revision,expires_at,data)
               VALUES(?,'gedcom',?,?,?,?)`,
            )
            .run(
              token,
              actor.id,
              current.revision,
              Date.now() + 15 * 60000,
              JSON.stringify(parsed.family),
            );
          const existing = new Set(
            current.family.people.map(
              (p) => `${fullName(p).toLocaleLowerCase("ru")}|${p.birth}`,
            ),
          );
          const possibleDuplicates = parsed.family.people.filter((p) =>
            existing.has(`${fullName(p).toLocaleLowerCase("ru")}|${p.birth}`),
          );
          return json(200, {
            token,
            revision: current.revision,
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
            warnings: parsed.warnings.slice(0, 100),
            warningCount: parsed.warnings.length,
            possibleDuplicates: possibleDuplicates.slice(0, 30).map(fullName),
            duplicateCount: possibleDuplicates.length,
            sample: parsed.family.people
              .slice(0, 20)
              .map((p) => ({
                name: fullName(p),
                birth: p.birth,
                death: p.death,
              })),
          });
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const stage =
          typeof body.token === "string" ? getStage(body.token) : undefined;
        if (body.confirm !== true || !stage || stage.actor !== actor.id)
          return json(400, {
            error: "Проверьте файл и подтвердите импорт заново",
          });
        if (stage.revision !== current.revision)
          return json(409, {
            error:
              "Архив изменился после предпросмотра. Проверьте GEDCOM заново.",
          });
        const directory = join(dirname(dbPath), "backups");
        mkdirSync(directory, { recursive: true });
        writeDatabaseBackup(
          archive.db,
          join(directory, `before-gedcom-${Date.now()}-${randomUUID()}.sqlite`),
        );
        const result = archive.write(
          {
            ...current.family,
            people: [...current.family.people, ...stage.family.people],
            links: [
              ...(current.family.links || []),
              ...(stage.family.links || []),
            ],
          },
          stage.revision,
          currentActor,
          "Импорт GEDCOM",
        );
        archive.db
          .prepare("DELETE FROM workflow_stages WHERE kind='gedcom' AND token=?")
          .run(body.token);
        return json(200, {
          revision: result.revision,
          added: stage.family.people.length,
        });
      } catch (e) {
        return json(e instanceof ConflictError ? 409 : 400, {
          error: (e as Error).message,
        });
      }
    },
  };
}
