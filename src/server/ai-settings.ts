import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser } from "../domain/access.ts";
import { auditStore } from "./audit.ts";

export type AiSettings = {
  enabled: boolean;
  model: string;
};

function modelValue(value: unknown) {
  if (typeof value !== "string") throw new Error("Укажите модель AI Studio");
  const model = value.trim();
  if (model.length > 300) throw new Error("Слишком длинное имя модели");
  if (model && !/^[a-zA-Z0-9._:/-]+$/.test(model))
    throw new Error("Некорректное имя модели");
  return model;
}

export function aiSettingsStore(db: DatabaseSync) {
  const audit = auditStore(db);
  db.prepare(
    "INSERT OR IGNORE INTO ai_settings(id,enabled,model) VALUES(1,1,'')",
  ).run();

  function read(): AiSettings {
    const row = db
      .prepare("SELECT enabled,model FROM ai_settings WHERE id=1")
      .get()!;
    return {
      enabled: !!row.enabled,
      model: String(row.model || ""),
    };
  }

  return {
    read,
    write(value: unknown, actor: ArchiveUser) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Некорректные настройки AI Studio");
      const raw = value as Record<string, unknown>;
      if (typeof raw.enabled !== "boolean")
        throw new Error("Укажите, включён ли ИИ-исследователь");
      const before = read(),
        afterInput: AiSettings = {
          enabled: raw.enabled,
          model: modelValue(raw.model),
        };
      db.prepare("UPDATE ai_settings SET enabled=?,model=? WHERE id=1").run(
        Number(afterInput.enabled),
        afterInput.model,
      );
      const after = read(),
        details = [
          ...(before.enabled !== after.enabled
            ? [
                {
                  field: "ИИ-исследователь",
                  before: before.enabled ? "Включён" : "Выключен",
                  after: after.enabled ? "Включён" : "Выключен",
                },
              ]
            : []),
          ...(before.model !== after.model
            ? [
                {
                  field: "Модель",
                  before: before.model || "Из окружения",
                  after: after.model || "Из окружения",
                },
              ]
            : []),
        ];
      if (details.length)
        audit.record(
          {
            action: "Изменены настройки ИИ",
            entity: "settings",
            entityId: "ai",
            label: "AI Studio",
            personIds: [],
            details,
          },
          actor,
        );
      return after;
    },
  };
}

export function aiRuntimeConfig(settings: ReturnType<typeof aiSettingsStore>) {
  const stored = settings.read(),
    apiKey = process.env.YANDEX_AI_API_KEY?.trim() || "",
    folderId = process.env.YANDEX_AI_FOLDER_ID?.trim() || "",
    envModel = process.env.YANDEX_AI_MODEL?.trim() || "yandexgpt/rc",
    model = stored.model || envModel,
    modelUri = model.startsWith("gpt://")
      ? model
      : folderId
        ? `gpt://${folderId}/${model}`
        : model,
    baseUrl = (
      process.env.YANDEX_AI_BASE_URL || "https://ai.api.cloud.yandex.net/v1"
    ).replace(/\/$/, ""),
    configured = !!apiKey && (!!folderId || model.startsWith("gpt://"));
  return {
    enabled: stored.enabled,
    active: stored.enabled && configured,
    configured,
    apiKey,
    apiKeyConfigured: !!apiKey,
    folderId,
    folderConfigured: !!folderId,
    model,
    modelUri,
    modelOverride: stored.model,
    modelSource: stored.model
      ? "database"
      : process.env.YANDEX_AI_MODEL?.trim()
        ? "environment"
        : "default",
    baseUrl,
  };
}

export function publicAiStatus(settings: ReturnType<typeof aiSettingsStore>) {
  const runtime = aiRuntimeConfig(settings);
  return {
    enabled: runtime.enabled,
    active: runtime.active,
    configured: runtime.configured,
    apiKeyConfigured: runtime.apiKeyConfigured,
    folderConfigured: runtime.folderConfigured,
    model: runtime.model,
    modelOverride: runtime.modelOverride,
    modelSource: runtime.modelSource,
    baseUrl: runtime.baseUrl,
  };
}
