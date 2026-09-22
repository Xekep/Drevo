import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const memoryKeys = new WeakMap<DatabaseSync, Buffer>();

function databaseFile(db: DatabaseSync) {
  const rows = db.prepare("PRAGMA database_list").all();
  const main = rows.find((row) => String(row.name) === "main");
  return main?.file ? String(main.file) : "";
}

function keyFile(db: DatabaseSync) {
  const file = databaseFile(db);
  return file ? file + ".secrets.key" : "";
}

function readKeyFile(path: string) {
  if (!existsSync(path)) return null;
  const key = readFileSync(path);
  if (key.length !== 32)
    throw new Error("Некорректный локальный ключ шифрования AI Studio");
  try {
    chmodSync(path, 0o600);
  } catch {
    // На некоторых файловых системах chmod недоступен; чтение всё равно возможно.
  }
  return key;
}

function secretKey(db: DatabaseSync, create: boolean) {
  const path = keyFile(db);
  if (!path) {
    const existing = memoryKeys.get(db);
    if (existing) return existing;
    if (!create) return null;
    const generated = randomBytes(32);
    memoryKeys.set(db, generated);
    return generated;
  }

  const existing = readKeyFile(path);
  if (existing) return existing;
  if (!create) return null;

  const generated = randomBytes(32);
  try {
    writeFileSync(path, generated, { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!existsSync(path)) throw error;
    return readKeyFile(path);
  }
}

export function encryptAiSecret(db: DatabaseSync, value: string) {
  const key = secretKey(db, true)!,
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv),
    encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]),
    tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptAiSecret(db: DatabaseSync, value: string) {
  if (!value) return "";
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== "v1" ||
    !parts[1] ||
    !parts[2] ||
    parts[3] === undefined
  )
    throw new Error("Некорректный формат сохранённого API-ключа");
  const key = secretKey(db, false);
  if (!key)
    throw new Error(
      "Локальный ключ шифрования AI Studio не найден. Введите API-ключ заново.",
    );
  const iv = Buffer.from(parts[1], "base64url"),
    tag = Buffer.from(parts[2], "base64url"),
    encrypted = Buffer.from(parts[3], "base64url"),
    decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

export function aiSecretKeyPath(db: DatabaseSync) {
  return keyFile(db) || null;
}
