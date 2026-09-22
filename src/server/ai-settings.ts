import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser } from "../domain/access.ts";
import { auditStore } from "./audit.ts";
import { decryptAiSecret, encryptAiSecret } from "./ai-secret.ts";

export type AiSettings = {
  enabled: boolean;
  model: string;
  folderId: string;
  apiKeyStored: boolean;
  requestsPerMinute: number;
  dailyRequests: number;
  dailyTokens: number;
};

type AiSettingsRow = {
  enabled: unknown;
  model: unknown;
  folder_id: unknown;
  api_key_ciphertext: unknown;
  requests_per_minute: unknown;
  daily_requests: unknown;
  daily_tokens: unknown;
};

function modelValue(value: unknown) {
  if (typeof value !== "string") throw new Error("Укажите модель AI Studio");
  const model = value.trim();
  if (
    model.length > 512 ||
    (model && !/^(?:gpt:\/\/[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9._/@-]+$/.test(model))
  )
    throw new Error("Некорректный идентификатор модели AI Studio");
  return model;
}

function folderIdValue(value: unknown) {
  if (typeof value !== "string") throw new Error("Укажите Folder ID");
  const folderId = value.trim();
  if (folderId.length > 128 || (folderId && !/^[a-zA-Z0-9_-]+$/.test(folderId)))
    throw new Error("Некорректный Folder ID");
  return folderId;
}

function apiKeyValue(value: unknown) {
  if (typeof value !== "string") throw new Error("Некорректный API-ключ");
  const apiKey = value.trim();
  if (apiKey && (apiKey.length < 10 || apiKey.length > 1000))
    throw new Error("Некорректная длина API-ключа");
  return apiKey;
}

function integerValue(
  value: unknown,
  label: string,
  min: number,
  max: number,
) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Некорректное значение «${label}»`);
  return value;
}

export function aiSettingsStore(db: DatabaseSync) {
  const audit = auditStore(db);
  db.prepare(
    `INSERT OR IGNORE INTO ai_settings(
      id,enabled,model,folder_id,api_key_ciphertext,
      requests_per_minute,daily_requests,daily_tokens
    ) VALUES(1,1,'','','',6,100,250000)`,
  ).run();

  function row() {
    return db
      .prepare(
        `SELECT enabled,model,folder_id,api_key_ciphertext,
                requests_per_minute,daily_requests,daily_tokens
         FROM ai_settings WHERE id=1`,
      )
      .get() as AiSettingsRow;
  }

  function read(): AiSettings {
    const value = row();
    return {
      enabled: !!value.enabled,
      model: String(value.model || ""),
      folderId: String(value.folder_id || ""),
      apiKeyStored: !!String(value.api_key_ciphertext || ""),
      requestsPerMinute: Number(value.requests_per_minute),
      dailyRequests: Number(value.daily_requests),
      dailyTokens: Number(value.daily_tokens),
    };
  }

  function savedApiKey() {
    const ciphertext = String(row().api_key_ciphertext || "");
    if (!ciphertext) return { value: "", stored: false, error: "" };
    try {
      return {
        value: decryptAiSecret(db, ciphertext),
        stored: true,
        error: "",
      };
    } catch (error) {
      return {
        value: "",
        stored: true,
        error:
          error instanceof Error
            ? error.message
            : "Не удалось расшифровать сохранённый API-ключ",
      };
    }
  }

  return {
    read,
    savedApiKey,
    write(value: unknown, actor: ArchiveUser) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Некорректные настройки AI Studio");
      const raw = value as Record<string, unknown>;
      if (typeof raw.enabled !== "boolean")
        throw new Error("Укажите, включён ли ИИ-исследователь");
      if (
        raw.clearApiKey !== undefined &&
        typeof raw.clearApiKey !== "boolean"
      )
        throw new Error("Некорректная команда удаления API-ключа");

      const before = read(),
        current = row(),
        newApiKey =
          raw.apiKey === undefined ? "" : apiKeyValue(raw.apiKey),
        clearApiKey = raw.clearApiKey === true;
      let ciphertext = String(current.api_key_ciphertext || "");
      if (clearApiKey) ciphertext = "";
      if (newApiKey) ciphertext = encryptAiSecret(db, newApiKey);

      const afterInput = {
        enabled: raw.enabled,
        model: modelValue(raw.model),
        folderId: folderIdValue(raw.folderId),
        requestsPerMinute: integerValue(
          raw.requestsPerMinute,
          "Запросов в минуту",
          0,
          120,
        ),
        dailyRequests: integerValue(
          raw.dailyRequests,
          "Запросов в день",
          0,
          100000,
        ),
        dailyTokens: integerValue(
          raw.dailyTokens,
          "Токенов в день",
          0,
          1000000000,
        ),
      };

      db.prepare(
        `UPDATE ai_settings SET
          enabled=?,model=?,folder_id=?,api_key_ciphertext=?,
          requests_per_minute=?,daily_requests=?,daily_tokens=?
         WHERE id=1`,
      ).run(
        Number(afterInput.enabled),
        afterInput.model,
        afterInput.folderId,
        ciphertext,
        afterInput.requestsPerMinute,
        afterInput.dailyRequests,
        afterInput.dailyTokens,
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
          ...(before.folderId !== after.folderId
            ? [
                {
                  field: "Folder ID",
                  before: before.folderId || "Из окружения",
                  after: after.folderId || "Из окружения",
                },
              ]
            : []),
          ...(before.apiKeyStored !== after.apiKeyStored || !!newApiKey
            ? [
                {
                  field: "API-ключ",
                  before: before.apiKeyStored ? "Сохранён" : "Не сохранён",
                  after: after.apiKeyStored ? "Сохранён" : "Удалён",
                },
              ]
            : []),
          ...([
            ["requestsPerMinute", "Запросов в минуту"],
            ["dailyRequests", "Запросов в день"],
            ["dailyTokens", "Токенов в день"],
          ] as const).flatMap(([key, label]) =>
            before[key] !== after[key]
              ? [
                  {
                    field: label,
                    before: String(before[key]),
                    after: String(after[key]),
                  },
                ]
              : [],
          ),
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
    savedSecret = settings.savedApiKey(),
    envApiKey = process.env.YANDEX_AI_API_KEY?.trim() || "",
    envFolderId = process.env.YANDEX_AI_FOLDER_ID?.trim() || "",
    envModel = process.env.YANDEX_AI_MODEL?.trim() || "",
    apiKey = savedSecret.value || envApiKey,
    folderId = stored.folderId || envFolderId,
    model = stored.model || envModel,
    modelUri = model.startsWith("gpt://")
      ? model
      : folderId
        ? `gpt://${folderId}/${model}`
        : model,
    baseUrl = (
      process.env.YANDEX_AI_BASE_URL || "https://ai.api.cloud.yandex.net/v1"
    ).replace(/\/$/, ""),
    configured =
      !!apiKey && !!model && (!!folderId || model.startsWith("gpt://"));
  return {
    enabled: stored.enabled,
    active: stored.enabled && configured,
    configured,
    apiKey,
    apiKeyConfigured: !!apiKey,
    apiKeyStored: stored.apiKeyStored,
    apiKeySource: savedSecret.value
      ? "database"
      : envApiKey
        ? "environment"
        : "none",
    credentialError: savedSecret.error,
    folderId,
    folderIdOverride: stored.folderId,
    folderConfigured: !!folderId,
    folderSource: stored.folderId
      ? "database"
      : envFolderId
        ? "environment"
        : "none",
    model,
    modelUri,
    modelOverride: stored.model,
    modelSource: stored.model
      ? "database"
      : envModel
        ? "environment"
        : "default",
    limits: {
      requestsPerMinute: stored.requestsPerMinute,
      dailyRequests: stored.dailyRequests,
      dailyTokens: stored.dailyTokens,
    },
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
    apiKeyStored: runtime.apiKeyStored,
    apiKeySource: runtime.apiKeySource,
    credentialError: runtime.credentialError,
    folderId: runtime.folderId,
    folderIdOverride: runtime.folderIdOverride,
    folderConfigured: runtime.folderConfigured,
    folderSource: runtime.folderSource,
    model: runtime.model,
    modelOverride: runtime.modelOverride,
    modelSource: runtime.modelSource,
    limits: runtime.limits,
    baseUrl: runtime.baseUrl,
  };
}
