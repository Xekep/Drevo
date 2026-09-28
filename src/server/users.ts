import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser, Role, TreeAccess } from "../domain/access.ts";
import { ROLE_NAMES } from "../domain/access.ts";
import { auditStore } from "./audit.ts";
export class ForbiddenError extends Error {}

type UserStoreOptions = {
  initialAdminId?: string;
  requireInitialAdmin?: boolean;
};

export function userStore(
  db: DatabaseSync,
  options: UserStoreOptions = {
    initialAdminId: process.env.INITIAL_ADMIN_YANDEX_ID,
    requireInitialAdmin:
      !!process.env.PUBLIC_ORIGIN &&
      (process.env.NODE_ENV === "production" ||
        process.argv.includes("--production")),
  },
) {
  const audit = auditStore(db),
    initialAdminId = options.initialAdminId?.trim() || "";
  if (initialAdminId.length > 100)
    throw new Error(
      "INITIAL_ADMIN_YANDEX_ID должен быть не длиннее 100 символов",
    );
  const adminCount = () =>
    Number(
      db.prepare("SELECT count(*) AS n FROM users WHERE role='admin'").get()!.n,
    );
  if (options.requireInitialAdmin && adminCount() === 0 && !initialAdminId)
    throw new Error(
      "Для первого запуска production задайте INITIAL_ADMIN_YANDEX_ID в /etc/drevo.env",
    );
  const convert = (row: Record<string, unknown>): ArchiveUser => ({
    id: String(row.id),
    name: String(row.name),
    role: row.role as Role,
    createdAt: String(row.created_at),
    lastVisitAt: row.last_visit_at ? String(row.last_visit_at) : undefined,
    approved: !!row.approved,
    personId: row.person_id ? String(row.person_id) : undefined,
    treeAccess: (row.tree_access || "all") as TreeAccess,
  });
  function get(id: string) {
    const row = db.prepare("SELECT * FROM users WHERE id=?").get(id);
    return row ? convert(row) : null;
  }
  const updateVisit = db.prepare(
    "UPDATE users SET last_visit_at=? WHERE id=? AND (last_visit_at IS NULL OR last_visit_at<?)",
  );
  function recordVisit(id: string, now = Date.now(), interval = 0) {
    const at = new Date(now).toISOString();
    updateVisit.run(at, id, new Date(now - interval).toISOString());
  }
  function register(id: string, name: string) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = get(id);
      if (existing)
        db.prepare("UPDATE users SET name=? WHERE id=?").run(name, id);
      else {
        const firstAdmin =
          !id.startsWith("vk:") &&
          adminCount() === 0 &&
          (initialAdminId
            ? id === initialAdminId
            : Number(db.prepare("SELECT count(*) AS n FROM users").get()!.n) ===
              0);
        db.prepare(
          "INSERT INTO users(id,name,role,approved) VALUES(?,?,?,?)",
        ).run(id, name, firstAdmin ? "admin" : "reader", Number(firstAdmin));
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
      if (target.role === "admin" && role !== "admin" && adminCount() <= 1)
        throw new Error("Нельзя убрать последнего администратора");
      db.prepare(
        "UPDATE users SET role=?,approved=1,tree_access=CASE WHEN ?='admin' THEN 'all' ELSE tree_access END WHERE id=?",
      ).run(role, role, id);
      if (target.role !== role || !target.approved)
        audit.record(
          {
            action: "Изменена роль",
            entity: "user",
            entityId: id,
            label: target.name,
            personIds: [],
            details: [
              {
                field: "Роль",
                before: ROLE_NAMES[target.role],
                after: ROLE_NAMES[role],
              },
            ],
          },
          actor,
        );
      db.exec("COMMIT");
      return get(id)!;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function setApproved(actor: ArchiveUser, id: string, approved: boolean) {
    if (actor.id !== "local" && get(actor.id)?.role !== "admin")
      throw new ForbiddenError("Управлять доступом может только администратор");
    const target = get(id);
    if (!target) throw new Error("Пользователь не найден");
    if (target.role === "admin" && !approved)
      throw new Error("Нельзя заблокировать администратора");
    db.prepare("UPDATE users SET approved=? WHERE id=?").run(
      Number(approved),
      id,
    );
    if (!approved)
      db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(id);
    return get(id)!;
  }
  function setIdentity(
    actor: ArchiveUser,
    id: string,
    personId: string | null,
    treeAccess: TreeAccess,
  ) {
    if (actor.id !== "local" && get(actor.id)?.role !== "admin")
      throw new ForbiddenError("Управлять доступом может только администратор");
    const target = get(id);
    if (!target) throw new Error("Пользователь не найден");
    if (typeof personId !== "string" && personId !== null)
      throw new Error("Некорректный человек");
    if (
      personId &&
      !db.prepare("SELECT 1 FROM people WHERE id=?").get(personId)
    )
      throw new Error("Человек не найден в древе");
    if (
      personId &&
      db
        .prepare("SELECT 1 FROM users WHERE person_id=? AND id<>?")
        .get(personId, id)
    )
      throw new Error("Этот человек уже связан с другим участником");
    if (!["all", "common_ancestors"].includes(treeAccess))
      throw new Error("Неизвестный режим доступа");
    if (treeAccess === "common_ancestors" && !personId)
      throw new Error("Для доступа по общим предкам сначала выберите человека");
    if (target.role === "admin" && treeAccess !== "all")
      throw new Error("Администратору нужен доступ ко всему древу");
    if (treeAccess === "common_ancestors") {
      const publicAccess = db
        .prepare(
          "SELECT public_tree,public_albums FROM access_settings WHERE id=1",
        )
        .get();
      if (publicAccess?.public_tree || publicAccess?.public_albums)
        throw new Error(
          "Для ограниченного доступа сначала закройте публичное древо и альбомы",
        );
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE users SET person_id=?,tree_access=? WHERE id=?").run(
        personId || null,
        treeAccess,
        id,
      );
      if (
        target.personId !== (personId || undefined) ||
        target.treeAccess !== treeAccess
      )
        audit.record(
          {
            action: "Изменена привязка к древу",
            entity: "user",
            entityId: id,
            label: target.name,
            personIds: personId ? [personId] : [],
            details: [
              {
                field: "Человек",
                before: target.personId || "",
                after: personId || "",
              },
              {
                field: "Доступ",
                before: target.treeAccess || "all",
                after: treeAccess,
              },
            ],
          },
          actor,
        );
      const result = get(id)!;
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function listPage(limit: number, cursor?: string) {
    let after: [string, string] | undefined;
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        );
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 2 ||
          typeof parsed[0] !== "string" ||
          typeof parsed[1] !== "string" ||
          parsed[0].length > 40 ||
          parsed[1].length > 100
        )
          throw new Error();
        after = [parsed[0], parsed[1]];
      } catch {
        throw new Error("Некорректная страница участников");
      }
    }
    const rows = after
      ? db
          .prepare(
            "SELECT * FROM users WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?",
          )
          .all(after[0], after[1], limit + 1)
      : db
          .prepare(
            "SELECT * FROM users ORDER BY created_at DESC,id DESC LIMIT ?",
          )
          .all(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      users: page.map(convert),
      next:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString(
              "base64url",
            )
          : null,
      total: Number(db.prepare("SELECT count(*) AS n FROM users").get()!.n),
    };
  }
  function remove(actor: ArchiveUser, id: string) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (actor.id !== "local" && get(actor.id)?.role !== "admin")
        throw new ForbiddenError(
          "Управлять доступом может только администратор",
        );
      if (actor.id === id)
        throw new Error("Нельзя удалить собственный аккаунт");
      const target = get(id);
      if (!target) throw new Error("Пользователь не найден");
      if (target.role === "admin" && adminCount() <= 1)
        throw new Error("Нельзя удалить последнего администратора");
      audit.record(
        {
          action: "Удалён участник",
          entity: "user",
          entityId: id,
          label: target.name,
          personIds: target.personId ? [target.personId] : [],
          details: [
            { field: "Роль", before: ROLE_NAMES[target.role], after: "Удалён" },
          ],
        },
        actor,
      );
      db.prepare("DELETE FROM user_tree_preferences WHERE user_id=?").run(id);
      db.prepare("DELETE FROM users WHERE id=?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    get,
    recordVisit,
    register,
    setRole,
    setApproved,
    setIdentity,
    listPage,
    remove,
    list: () =>
      db
        .prepare("SELECT * FROM users ORDER BY created_at,id")
        .all()
        .map(convert),
  };
}
