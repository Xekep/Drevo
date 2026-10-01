import type { ClaimConfidence } from "./types.ts";

export const CLAIM_CONFIDENCE_LABELS: Record<ClaimConfidence, string> = {
  confirmed: "Подтверждено",
  probable: "Вероятно",
  tentative: "Предположительно",
  conflicting: "Противоречиво",
  unknown: "Неизвестно",
};

export function isClaimConfidence(value: unknown): value is ClaimConfidence {
  return typeof value === "string" && Object.hasOwn(CLAIM_CONFIDENCE_LABELS, value);
}
