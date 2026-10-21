import {
  BASIC_MEDIA_BYTES,
  BASIC_PEOPLE_LIMIT,
} from "../shared/account-limits.ts";

export function accountCapabilitySummary(fullAccess: boolean) {
  return fullAccess
    ? "Базовые лимиты сняты · ИИ по роли и древу"
    : `${BASIC_PEOPLE_LIMIT} человек · ${BASIC_MEDIA_BYTES / 1_000_000} МБ · Без ИИ`;
}
