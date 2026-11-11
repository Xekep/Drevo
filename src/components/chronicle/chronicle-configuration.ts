import { archiveFetch } from "../../data/archive-fetch.ts";
import {
  validateChronicleSettings,
  type ChronicleConfiguration,
  type ChronicleSettings,
} from "../../shared/chronicle-settings.ts";

export class ChronicleConfigurationError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function configuration(
  response: Response,
): Promise<ChronicleConfiguration> {
  const body = await response.json();
  if (!response.ok)
    throw new ChronicleConfigurationError(
      body.error || "Не удалось загрузить настройки хроники",
      response.status,
    );
  if (
    !Number.isSafeInteger(body.version) ||
    body.version < 0 ||
    typeof body.canConfigure !== "boolean"
  )
    throw new Error("Некорректный ответ настроек хроники");
  return {
    version: body.version,
    settings: validateChronicleSettings(body.settings),
    canConfigure: body.canConfigure,
  };
}
export async function readChronicleConfiguration(signal?: AbortSignal) {
  return configuration(
    await archiveFetch("/api/chronicle-settings", {
      signal,
      cache: "no-store",
    }),
  );
}
export async function saveChronicleConfiguration(
  settings: ChronicleSettings,
  version: number,
  signal: AbortSignal,
) {
  return configuration(
    await archiveFetch("/api/chronicle-settings", {
      method: "PUT",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings, version }),
    }),
  );
}
