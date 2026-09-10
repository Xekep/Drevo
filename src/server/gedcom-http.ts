import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { ConflictError } from "./database.ts";
import { importGedcom, exportGedcom } from "../domain/gedcom.ts";
import { databaseBackup } from "./backup.ts";
import { fullName } from "../domain/dates.ts";
import type { Family } from "../domain/types.ts";
export function gedcomHttp(
  archive: ReturnType<typeof openArchive>,
  auth: ReturnType<typeof createAuth>,
  dbPath: string,
  publicOrigin?: string,
) {
  const stages = new Map<
    string,
    { family: Family; actor: string; revision: number; expires: number }
  >();
  const clean = () => {
    for (const [token, stage] of stages)
      if (stage.expires <= Date.now()) stages.delete(token);
  };
  const timer = setInterval(clean, 60000);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
      stages.clear();
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
      if (
        (req.headers.origin &&
          req.headers.origin !==
            (publicOrigin || `http://${req.headers.host}`)) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
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
          for (const [token, s] of stages)
            if (s.actor === actor.id) stages.delete(token);
          if (stages.size >= 3)
            return json(429, {
              error: "Уже проверяется несколько импортов. Повторите позже.",
            });
          const token = randomUUID();
          stages.set(token, {
            family: parsed.family,
            actor: actor.id,
            revision: current.revision,
            expires: Date.now() + 15 * 60000,
          });
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
          typeof body.token === "string" ? stages.get(body.token) : undefined;
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
        writeFileSync(
          join(directory, `before-gedcom-${Date.now()}-${randomUUID()}.sqlite`),
          databaseBackup(archive.db),
          { mode: 0o600, flag: "wx" },
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
        stages.delete(body.token);
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
