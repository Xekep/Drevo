const stages = ["open", "snapshot", "sanitize", "validate"] as const;
const codes = [
  "disk-full",
  "permission",
  "schema",
  "foreign-keys",
  "invalid-value",
  "integrity",
  "database",
  "unknown",
] as const;
export type BackupWorkerStage = (typeof stages)[number];
export type BackupWorkerFailure = {
  type: "backup-worker-failure";
  version: 1;
  stage: BackupWorkerStage;
  code: (typeof codes)[number];
  field?: string;
};
const fieldPattern = /^[a-z_]{1,64}\.[a-z_]{1,64}$/;

/** A closed protocol: values, SQL, credentials, filenames and raw stderr never cross it. */
export function readBackupWorkerFailure(
  value: unknown,
): BackupWorkerFailure | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    item.type !== "backup-worker-failure" ||
    item.version !== 1 ||
    !stages.some((stage) => stage === item.stage) ||
    !codes.some((code) => code === item.code)
  )
    return null;
  return {
    type: "backup-worker-failure",
    version: 1,
    stage: item.stage as BackupWorkerStage,
    code: item.code as BackupWorkerFailure["code"],
    ...(item.code === "invalid-value" &&
    typeof item.field === "string" &&
    fieldPattern.test(item.field)
      ? { field: item.field }
      : {}),
  };
}

export function backupWorkerFailure(
  error: unknown,
  stage: BackupWorkerStage,
): BackupWorkerFailure {
  const saved =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown; errcode?: unknown })
      : {};
  const code = typeof saved.code === "string" ? saved.code : "";
  const message = typeof saved.message === "string" ? saved.message : "";
  const field = /^Некорректное поле копии: ([a-z_]{1,64}\.[a-z_]{1,64})$/.exec(
    message,
  )?.[1];
  let kind: BackupWorkerFailure["code"] = "unknown";
  if (
    ["ENOSPC", "SQLITE_FULL"].includes(code) ||
    saved.errcode === 13 ||
    /Недостаточно (?:места|свободного места)/.test(message)
  )
    kind = "disk-full";
  else if (
    [
      "EACCES",
      "EPERM",
      "42501",
      "SQLITE_READONLY",
      "SQLITE_PERM",
      "SQLITE_CANTOPEN",
    ].includes(code) ||
    [3, 8, 14, 23].includes(Number(saved.errcode))
  )
    kind = "permission";
  else if (
    ["42P01", "42703", "42804"].includes(code) ||
    /^no such (?:table|column):/.test(message)
  )
    kind = "schema";
  else if (
    code === "23503" ||
    saved.errcode === 787 ||
    /нарушенные ссылки/.test(message)
  )
    kind = "foreign-keys";
  else if (field) kind = "invalid-value";
  else if (
    [11, 26].includes(Number(saved.errcode)) ||
    /проверку целостности|failed integrity validation/.test(message)
  )
    kind = "integrity";
  else if (
    ["ECONNREFUSED", "ETIMEDOUT", "57P01", "53300", "28P01"].includes(code)
  )
    kind = "database";
  return {
    type: "backup-worker-failure",
    version: 1,
    stage,
    code: kind,
    ...(field ? { field } : {}),
  };
}

export function backupWorkerFailureMessage(
  failure: BackupWorkerFailure,
): string {
  const stage: Record<BackupWorkerStage, string> = {
    open: "Подключение к данным",
    snapshot: "Перенос данных в копию",
    sanitize: "Очистка служебных данных",
    validate: "Проверка целостности копии",
  };
  const reason: Record<BackupWorkerFailure["code"], string> = {
    "disk-full": "Недостаточно свободного места.",
    permission: "Нет доступа к данным или каталогу копии.",
    schema: "Схема данных не соответствует переносимому формату.",
    "foreign-keys": "В данных копии нарушены связи.",
    "invalid-value": `Не удалось преобразовать поле${failure.field ? ` ${failure.field}` : ""}.`,
    integrity: "Копия не прошла проверку целостности.",
    database: "База данных недоступна.",
    unknown:
      "Не удалось создать переносимую копию. Код этапа записан в журнал сервера.",
  };
  return `${stage[failure.stage]}: ${reason[failure.code]}`;
}
