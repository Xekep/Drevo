import { createHash, randomBytes } from "node:crypto";

export const SESSION_MAX_AGE = 90 * 24 * 60 * 60;

export function newSessionToken() {
  return randomBytes(32).toString("hex");
}

export function sessionTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function validSessionToken(token: string) {
  return /^[a-f0-9]{64}$/.test(token);
}
