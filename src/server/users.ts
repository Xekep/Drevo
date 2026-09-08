import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser, Role } from "../domain/access.ts";
export class ForbiddenError extends Error {}
export function userStore(db: DatabaseSync) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','relative','reader')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))) STRICT;`,
  );
  const convert = (row: Record<string, unknown>): ArchiveUser => ({
    id: String(row.id),
    name: String(row.name),
    role: row.role as Role,
    createdAt: String(row.created_at),
  });
  function get(id: string) {
    const row = db.prepare("SELECT * FROM users WHERE id=?").get(id);
    return row ? convert(row) : null;
  }
  function register(id: string, name: string) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = get(id);
      if (existing)
        db.prepare("UPDATE users SET name=? WHERE id=?").run(name, id);
      else {
        const first =
          Number(db.prepare("SELECT count(*) AS n FROM users").get()!.n) === 0;
        db.prepare("INSERT INTO users(id,name,role) VALUES(?,?,?)").run(
          id,
          name,
          first ? "admin" : "reader",
        );
      }
      const user = get(id)!;
      db.exec("COMMIT");
      return user;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function setRole(actor: ArchiveUser, id: string, role: Role) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (actor.id !== "local" && get(actor.id)?.role !== "admin")
        throw new ForbiddenError(
          "Управлять доступом может только администратор",
        );
      if (!["admin", "relative", "reader"].includes(role))
        throw new Error("Неизвестная роль");
      const target = get(id);
      if (!target) throw new Error("Пользователь не найден");
      if (
        target.role === "admin" &&
        role !== "admin" &&
        Number(
          db
            .prepare("SELECT count(*) AS n FROM users WHERE role='admin'")
            .get()!.n,
        ) <= 1
      )
        throw new Error("Нельзя убрать последнего администратора");
      db.prepare("UPDATE users SET role=? WHERE id=?").run(role, id);
      db.exec("COMMIT");
      return get(id)!;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    get,
    register,
    setRole,
    list: () =>
      db
        .prepare("SELECT * FROM users ORDER BY created_at,id")
        .all()
        .map(convert),
  };
}
