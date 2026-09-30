import type { Role } from "../domain/access.ts";

/** MiB per uploader within the current archive; null means no personal cap. */
export type StorageLimits = Record<Role, number | null>;
export const DEFAULT_STORAGE_LIMITS: StorageLimits = {
  admin: null, researcher: null, relative: null, reader: 0,
};
export function parseStorageLimits(value: unknown): StorageLimits | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result = { ...DEFAULT_STORAGE_LIMITS };
  for (const role of Object.keys(result) as Role[]) {
    const limit = input[role];
    if (limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 10_240)) return null;
    result[role] = limit as number | null;
  }
  return result;
}
