import {
  isTreeGenerationLimits,
  type TreePreferences,
} from "../domain/tree-preferences.ts";

const KEY = "drevo:guest-tree-preferences:v1";

/** Только параметры вида: без данных архива, аккаунта или токена ссылки. */
export function readGuestTreePreferences(
  fallback: TreePreferences,
): TreePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fallback;
    return {
      reverseTimeline:
        typeof value.reverseTimeline === "boolean"
          ? value.reverseTimeline
          : fallback.reverseTimeline,
      cardVariant: "portrait",
      colorScheme: ["warm", "white"].includes(value.colorScheme)
        ? value.colorScheme
        : fallback.colorScheme,
      ...(isTreeGenerationLimits(value.generationLimits)
        ? { generationLimits: value.generationLimits }
        : {}),
    };
  } catch {
    return fallback;
  }
}

export function writeGuestTreePreferences(value: TreePreferences) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        reverseTimeline: value.reverseTimeline,
        cardVariant: "portrait",
        colorScheme: value.colorScheme,
        ...(isTreeGenerationLimits(value.generationLimits)
          ? { generationLimits: value.generationLimits }
          : {}),
      }),
    );
  } catch {
    // При недоступном хранилище выбор всё равно действует в открытом древе.
  }
}
