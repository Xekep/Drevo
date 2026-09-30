import type { Role } from "../domain/access.ts";

/** Per-role policy. Null inherits the archive's common AI settings. */
export type AiRoleProfile = {
  enabled: boolean;
  model: string;
  visionModel: string;
  webSearchEnabled: boolean;
  globalSearchEnabled: boolean;
  photoAnalysisEnabled: boolean;
  proposalsEnabled: boolean;
  pdfEnabled: boolean;
  codeInterpreterEnabled: boolean;
  requestsPerMinute: number;
  dailyRequests: number;
  dailyTokens: number;
  compactionEnabled: boolean;
  compactThresholdTokens: number;
  automaticTruncation: boolean;
  maxToolIterations: number;
};

export type AiRoleProfiles = Record<Role, AiRoleProfile | null>;

export const AI_CAPABILITY_LABELS = {
  webSearchEnabled: "Поиск по доверенным ресурсам",
  globalSearchEnabled: "Поиск по всему интернету",
  photoAnalysisEnabled: "Анализ фотографий",
  proposalsEnabled: "Предложения изменений в архиве",
  pdfEnabled: "Создание PDF-отчётов",
  codeInterpreterEnabled: "Вычисления Python и файлы",
} as const;

export function inheritedAiRoleProfiles(): AiRoleProfiles {
  return { admin: null, researcher: null, relative: null, reader: null };
}
