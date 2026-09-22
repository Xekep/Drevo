import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser } from "../domain/access.ts";
import { auditStore } from "./audit.ts";

export type AiSettings = {
  model: string;
};

function modelValue(value: unknown) {
  if (typeof value !== "string")
    throw new Error("Укажите модель AI Studio");
  const model = value.trim();
  if (model.length > 300)
    throw new Error("Слишком длинное имя модели");
  if (model && !/^[a-zA-Z0-9._:/-]+$/.test(model))
    throw new Error("Некорректное имя модели");
  return model;
}

export function aiSettingsStore(db: DatabaseSync) {
  const audit = auditStore(db);
  db.prepare("INSERT OR IGNORE INTO ai_settings(id,model) VALUES(1,'')").run();

  function read(): AiSettings {
    const row = db.prepare("SELECT model FROM ai_settings WHERE id=1").get()!;
    return { model: String(row.model || "") };
  }

  return {
    read,
    write(value: unknown, actor: ArchiveUser) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Некорректные настройки AI Studio");
      const before = read(),
        model = modelValue((value as Record<string, unknown>).model);
      db.prepare("UPDATE ai_settings SET model=? WHERE id=1").run(model);
      const after = read();
      if (before.model !== after.model)
        audit.record(
          {
            action: "Изменены настройки ИИ",
            entity: "settings",
            entityId: "ai",
            label: "AI Studio",
            personIds: [],
            details: [
              {
                field: "Модель",
                before: before.model || "Из окружения",
                after: after.model || "Из окружения",
              },
            ],
          },
          actor,
        );
      return after;
    },
  };
}
