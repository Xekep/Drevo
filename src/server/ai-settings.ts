import type { StoreDatabase } from "./store-database.ts";
import { ROLE_NAMES, type ArchiveUser, type Role } from "../domain/access.ts";
import {
  inheritedAiRoleProfiles,
  type AiRoleProfile,
  type AiRoleProfiles,
} from "../shared/ai-role-profiles.ts";
import { auditStore } from "./audit.ts";
import { decryptAiSecret, encryptAiSecret } from "./ai-secret.ts";

export type AiSettings = {
  enabled: boolean;
  webSearchEnabled: boolean;
  model: string;
  folderId: string;
  apiKeyStored: boolean;
  requestsPerMinute: number;
  dailyRequests: number;
  dailyTokens: number;
  compactionEnabled: boolean;
  compactThresholdTokens: number;
  automaticTruncation: boolean;
  maxToolIterations: number;
  roleProfiles: AiRoleProfiles;
};

type AiSettingsRow = {
  enabled: unknown;
  web_search_enabled: unknown;
  model: unknown;
  folder_id: unknown;
  api_key_ciphertext: unknown;
  requests_per_minute: unknown;
  daily_requests: unknown;
  daily_tokens: unknown;
  compaction_enabled: unknown;
  compact_threshold_tokens: unknown;
  automatic_truncation: unknown;
  max_tool_iterations: unknown;
  role_profiles: unknown;
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

function integerValue(value: unknown, label: string, min: number, max: number) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Некорректное значение «${label}»`);
  return value;
}

function roleProfilesValue(value: unknown): AiRoleProfiles {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Некорректные AI-профили ролей");
  const profiles = inheritedAiRoleProfiles();
  for (const [role, profile] of Object.entries(value)) {
    if (!Object.hasOwn(profiles, role))
      throw new Error("Неизвестная роль AI-профиля");
    if (profile === null) continue;
    if (!profile || typeof profile !== "object" || Array.isArray(profile))
      throw new Error("Некорректный AI-профиль");
    const raw = profile as Record<string, unknown>;
    const defaults = defaultAiRoleProfile({
      enabled: true,
      model: "",
      webSearchEnabled: false,
      requestsPerMinute: 6,
      dailyRequests: 100,
      dailyTokens: 250000,
      compactionEnabled: true,
      compactThresholdTokens: 32000,
      automaticTruncation: true,
      maxToolIterations: 8,
    });
    for (const key of Object.keys(raw))
      if (!Object.hasOwn(defaults, key))
        throw new Error("Неизвестная настройка AI-профиля");
    for (const [key, fallback] of Object.entries(defaults))
      if (typeof fallback === "boolean" && typeof raw[key] !== "boolean")
        throw new Error(
          `Укажите настройку «${key}» для ${ROLE_NAMES[role as Role]}`,
        );
    profiles[role as Role] = {
      enabled: raw.enabled === true,
      model: modelValue(raw.model),
      visionModel: modelValue(raw.visionModel),
      webSearchEnabled: raw.webSearchEnabled === true,
      globalSearchEnabled: raw.globalSearchEnabled === true,
      photoAnalysisEnabled: raw.photoAnalysisEnabled === true,
      proposalsEnabled: raw.proposalsEnabled === true,
      pdfEnabled: raw.pdfEnabled === true,
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
      compactionEnabled: raw.compactionEnabled === true,
      compactThresholdTokens: integerValue(
        raw.compactThresholdTokens,
        "Порог сжатия",
        1000,
        1000000,
      ),
      automaticTruncation: raw.automaticTruncation === true,
      maxToolIterations: integerValue(
        raw.maxToolIterations,
        "Шагов инструментов",
        1,
        20,
      ),
    };
  }
  return profiles;
}

export function defaultAiRoleProfile(
  settings: Pick<
    AiSettings,
    | "enabled"
    | "model"
    | "webSearchEnabled"
    | "requestsPerMinute"
    | "dailyRequests"
    | "dailyTokens"
    | "compactionEnabled"
    | "compactThresholdTokens"
    | "automaticTruncation"
    | "maxToolIterations"
  >,
): AiRoleProfile {
  return {
    enabled: true,
    model: settings.model,
    visionModel: "",
    webSearchEnabled: settings.webSearchEnabled,
    globalSearchEnabled: true,
    photoAnalysisEnabled: true,
    proposalsEnabled: true,
    pdfEnabled: true,
    requestsPerMinute: settings.requestsPerMinute,
    dailyRequests: settings.dailyRequests,
    dailyTokens: settings.dailyTokens,
    compactionEnabled: settings.compactionEnabled,
    compactThresholdTokens: settings.compactThresholdTokens,
    automaticTruncation: settings.automaticTruncation,
    maxToolIterations: settings.maxToolIterations,
  };
}

export async function aiSettingsStore(db: StoreDatabase) {
  const audit = auditStore(db);
  await db
    .prepare(
      `INSERT OR IGNORE INTO ai_settings(
      id,enabled,model,folder_id,api_key_ciphertext,
      requests_per_minute,daily_requests,daily_tokens
    ) VALUES(1,1,'','','',6,100,250000)`,
      "INSERT INTO ai_settings(\n      id,enabled,model,folder_id,api_key_ciphertext,\n      requests_per_minute,daily_requests,daily_tokens\n    ) VALUES(1,1,'','','',6,100,250000) ON CONFLICT DO NOTHING",
    )
    .run();

  async function row() {
    return (await db
      .prepare(
        `SELECT enabled,web_search_enabled,model,folder_id,api_key_ciphertext,
                requests_per_minute,daily_requests,daily_tokens,
                compaction_enabled,compact_threshold_tokens,
                automatic_truncation,max_tool_iterations,role_profiles
         FROM ai_settings WHERE id=1`,
        "SELECT enabled,web_search_enabled,model,folder_id,api_key_ciphertext,\n                requests_per_minute,daily_requests,daily_tokens,\n                compaction_enabled,compact_threshold_tokens,\n                automatic_truncation,max_tool_iterations,role_profiles\n         FROM ai_settings WHERE id=1",
      )
      .get()) as AiSettingsRow;
  }

  async function read(): Promise<AiSettings> {
    const value = await row();
    return {
      enabled: !!value.enabled,
      webSearchEnabled:
        value.web_search_enabled === null
          ? process.env.AI_WEB_SEARCH_ENABLED === "true"
          : !!value.web_search_enabled,
      model: String(value.model || ""),
      folderId: String(value.folder_id || ""),
      apiKeyStored: !!String(value.api_key_ciphertext || ""),
      requestsPerMinute: Number(value.requests_per_minute),
      dailyRequests: Number(value.daily_requests),
      dailyTokens: Number(value.daily_tokens),
      compactionEnabled: !!value.compaction_enabled,
      compactThresholdTokens: Number(value.compact_threshold_tokens),
      automaticTruncation: !!value.automatic_truncation,
      maxToolIterations: Number(value.max_tool_iterations),
      roleProfiles: roleProfilesValue(
        JSON.parse(String(value.role_profiles || "{}")),
      ),
    };
  }

  async function savedApiKey() {
    const ciphertext = String((await row()).api_key_ciphertext || "");
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
    async write(value: unknown, actor: ArchiveUser) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Некорректные настройки AI Studio");
      const raw = value as Record<string, unknown>;
      if (
        raw.webSearchEnabled !== undefined &&
        typeof raw.webSearchEnabled !== "boolean"
      )
        throw new Error("Укажите, включён ли веб-поиск");
      if (typeof raw.enabled !== "boolean")
        throw new Error("Укажите, включён ли ИИ-исследователь");
      if (raw.clearApiKey !== undefined && typeof raw.clearApiKey !== "boolean")
        throw new Error("Некорректная команда удаления API-ключа");
      if (
        (raw.compactionEnabled !== undefined &&
          typeof raw.compactionEnabled !== "boolean") ||
        (raw.automaticTruncation !== undefined &&
          typeof raw.automaticTruncation !== "boolean")
      )
        throw new Error("Некорректные настройки контекста AI Studio");

      const before = await read(),
        current = await row(),
        newApiKey = raw.apiKey === undefined ? "" : apiKeyValue(raw.apiKey),
        clearApiKey = raw.clearApiKey === true;
      let ciphertext = String(current.api_key_ciphertext || "");
      if (clearApiKey) ciphertext = "";
      if (newApiKey) ciphertext = encryptAiSecret(db, newApiKey);

      const afterInput = {
        roleProfiles:
          raw.roleProfiles === undefined
            ? before.roleProfiles
            : roleProfilesValue(raw.roleProfiles),
        enabled: raw.enabled,
        webSearchEnabled:
          raw.webSearchEnabled === undefined
            ? before.webSearchEnabled
            : raw.webSearchEnabled === true,
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
        compactionEnabled:
          raw.compactionEnabled === undefined
            ? before.compactionEnabled
            : raw.compactionEnabled === true,
        compactThresholdTokens:
          raw.compactThresholdTokens === undefined
            ? before.compactThresholdTokens
            : integerValue(
                raw.compactThresholdTokens,
                "Порог сжатия",
                1000,
                1000000,
              ),
        automaticTruncation:
          raw.automaticTruncation === undefined
            ? before.automaticTruncation
            : raw.automaticTruncation === true,
        maxToolIterations:
          raw.maxToolIterations === undefined
            ? before.maxToolIterations
            : integerValue(raw.maxToolIterations, "Шагов инструментов", 1, 20),
      };

      await db
        .prepare(
          `UPDATE ai_settings SET
          enabled=?,web_search_enabled=?,model=?,folder_id=?,api_key_ciphertext=?,
          requests_per_minute=?,daily_requests=?,daily_tokens=?,
          compaction_enabled=?,compact_threshold_tokens=?,
          automatic_truncation=?,max_tool_iterations=?,role_profiles=?
         WHERE id=1`,
          "UPDATE ai_settings SET\n          enabled=?,web_search_enabled=?,model=?,folder_id=?,api_key_ciphertext=?,\n          requests_per_minute=?,daily_requests=?,daily_tokens=?,\n          compaction_enabled=?,compact_threshold_tokens=?,\n          automatic_truncation=?,max_tool_iterations=?,role_profiles=?\n         WHERE id=1",
        )
        .run(
          Number(afterInput.enabled),
          Number(afterInput.webSearchEnabled),
          afterInput.model,
          afterInput.folderId,
          ciphertext,
          afterInput.requestsPerMinute,
          afterInput.dailyRequests,
          afterInput.dailyTokens,
          Number(afterInput.compactionEnabled),
          afterInput.compactThresholdTokens,
          Number(afterInput.automaticTruncation),
          afterInput.maxToolIterations,
          JSON.stringify(afterInput.roleProfiles),
        );

      const after = await read(),
        details = [
          ...Object.keys(ROLE_NAMES).flatMap((role) => {
            const key = role as Role;
            return JSON.stringify(before.roleProfiles[key]) ===
              JSON.stringify(after.roleProfiles[key])
              ? []
              : [
                  {
                    field: `AI · ${ROLE_NAMES[key]}`,
                    before: JSON.stringify(before.roleProfiles[key]),
                    after: JSON.stringify(after.roleProfiles[key]),
                  },
                ];
          }),
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
          ...(
            [
              ["requestsPerMinute", "Запросов в минуту"],
              ["webSearchEnabled", "Поиск в интернете"],
              ["dailyRequests", "Запросов в день"],
              ["dailyTokens", "Токенов в день"],
            ] as const
          ).flatMap(([key, label]) =>
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
        await audit.record(
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

export async function aiRuntimeConfig(
  settings: Awaited<ReturnType<typeof aiSettingsStore>>,
  role?: Role,
) {
  const common = await settings.read(),
    profile = role ? common.roleProfiles[role] : null,
    stored = profile
      ? {
          ...common,
          ...profile,
          enabled: common.enabled && profile.enabled,
          model: profile.model || common.model,
        }
      : common,
    capabilities = profile || defaultAiRoleProfile(common),
    savedSecret = await settings.savedApiKey(),
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
    capabilities: {
      globalSearch: capabilities.globalSearchEnabled,
      photoAnalysis: capabilities.photoAnalysisEnabled,
      proposals: capabilities.proposalsEnabled,
      pdf: capabilities.pdfEnabled,
    },
    visionModel: capabilities.visionModel,
    enabled: stored.enabled,
    webSearchEnabled: stored.webSearchEnabled,
    webSearchProvider: process.env.AI_WEB_SEARCH_PROVIDER || "yandex",
    webSearchDefaultScope: "trusted" as const,
    webSearchTimeoutMs: Math.max(
      1000,
      Math.min(90000, Number(process.env.AI_WEB_SEARCH_TIMEOUT_MS) || 60000),
    ),
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
      dailyRequests: common.dailyRequests,
      dailyTokens: common.dailyTokens,
    },
    userLimits: profile
      ? {
          requestsPerMinute: profile.requestsPerMinute,
          dailyRequests: profile.dailyRequests,
          dailyTokens: profile.dailyTokens,
        }
      : null,
    compactionEnabled: stored.compactionEnabled,
    compactThresholdTokens: stored.compactThresholdTokens,
    automaticTruncation: stored.automaticTruncation,
    maxToolIterations: stored.maxToolIterations,
    baseUrl,
  };
}

export async function publicAiStatus(
  settings: Awaited<ReturnType<typeof aiSettingsStore>>,
) {
  const runtime = await aiRuntimeConfig(settings);
  const stored = await settings.read();
  return {
    roleProfiles: stored.roleProfiles,
    defaultRoleProfile: {
      ...defaultAiRoleProfile(stored),
      model: runtime.model,
    },
    enabled: runtime.enabled,
    webSearchEnabled: runtime.webSearchEnabled,
    webSearchProvider: runtime.webSearchProvider,
    webSearchDefaultScope: runtime.webSearchDefaultScope,
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
    compactionEnabled: runtime.compactionEnabled,
    compactThresholdTokens: runtime.compactThresholdTokens,
    automaticTruncation: runtime.automaticTruncation,
    maxToolIterations: runtime.maxToolIterations,
    baseUrl: runtime.baseUrl,
  };
}
