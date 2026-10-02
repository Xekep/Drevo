import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser, Role, TreeAccess } from "../domain/access.ts";
import { ROLE_NAMES } from "../domain/access.ts";
import { auditStore } from "./audit.ts";
export class ForbiddenError extends Error {}

/** Recheck the HTTP authorization snapshot after acquiring the archive lock.
 * PostgreSQL requests may have waited behind an administrator revoking access.
 */
export async function assertCurrentArchiveActor(
  db: StoreDatabase,
  actor: ArchiveUser,
) {
  if (
    db.kind !== "postgres" ||
    (actor.id === "local" && !process.env.PUBLIC_ORIGIN)
  )
    return;
  const row = await db
    .prepare(
      "",
      "SELECT role,approved,person_id,tree_access FROM archive_memberships WHERE archive_id=current_setting('drevo.archive_id',true) AND user_id=?",
    )
    .get(actor.id);
  if (
    !row ||
    !row.approved ||
    row.role !== actor.role ||
    (row.person_id || "") !== (actor.personId || "") ||
    row.tree_access !== (actor.treeAccess || "all")
  )
    throw new ForbiddenError(
      "Права доступа изменились. Обновите страницу перед сохранением.",
    );
}

type UserStoreOptions = {
  initialAdminId?: string;
  requireInitialAdmin?: boolean;
};

export async function userStore(
  db: StoreDatabase,
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
  const adminCount = async () =>
    Number(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM users WHERE role='admin'",
          "SELECT count(*) AS n FROM runtime_users WHERE role='admin'",
        )
        .get())!.n,
    );
  if (
    options.requireInitialAdmin &&
    (await adminCount()) === 0 &&
    !initialAdminId
  )
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
    fullAccess:
      row.full_access === undefined || row.full_access === null
        ? undefined
        : !!row.full_access,
  });
  async function get(id: string) {
    const row = await db
      .prepare(
        "SELECT * FROM users WHERE id=?",
        "SELECT u.*, t.full_access FROM runtime_users u LEFT JOIN account_tiers t ON t.account_id=u.id WHERE u.id=?",
      )
      .get(id);
    return row ? convert(row) : null;
  }
  const updateVisit = db.prepare(
    "UPDATE users SET last_visit_at=? WHERE id=? AND (last_visit_at IS NULL OR last_visit_at<?)",
    "UPDATE accounts SET last_visit_at=? WHERE id=? AND (last_visit_at IS NULL OR last_visit_at<?) AND EXISTS (SELECT 1 FROM archive_memberships m WHERE m.user_id=accounts.id)",
  );
  async function recordVisit(id: string, now = Date.now(), interval = 0) {
    const at = new Date(now).toISOString();
    await updateVisit.run(at, id, new Date(now - interval).toISOString());
  }
  async function register(id: string, name: string) {
    return await db.transaction(async () => {
      const existing = await get(id);
      if (existing)
        await db
          .prepare(
            "UPDATE users SET name=? WHERE id=?",
            "UPDATE accounts SET name=? WHERE id=? AND EXISTS (SELECT 1 FROM archive_memberships m WHERE m.user_id=accounts.id)",
          )
          .run(name, id);
      else {
        const firstAdmin =
          !id.startsWith("vk:") &&
          (await adminCount()) === 0 &&
          (initialAdminId
            ? id === initialAdminId
            : Number(
                (await db
                  .prepare(
                    "SELECT count(*) AS n FROM users",
                    "SELECT count(*) AS n FROM runtime_users",
                  )
                  .get())!.n,
              ) === 0);
        await db
          .prepare(
            "INSERT INTO users(id,name,role,approved) VALUES(?,?,?,?)",
            "WITH input(id,name,role,approved) AS (VALUES(?::text,?::text,?::text,?::integer)), added AS (INSERT INTO accounts(id,name) SELECT id,name FROM input ON CONFLICT(id) DO UPDATE SET name=excluded.name RETURNING id), tier AS (INSERT INTO account_tiers(account_id,full_access) SELECT id,false FROM added ON CONFLICT DO NOTHING), identity AS (INSERT INTO account_identities(provider,subject,account_id) SELECT CASE WHEN id LIKE 'vk:%' THEN 'vk' ELSE 'yandex' END, CASE WHEN id LIKE 'vk:%' THEN substring(id FROM 4) ELSE id END,id FROM added ON CONFLICT DO NOTHING) INSERT INTO archive_memberships(user_id,role,approved,tree_access) SELECT i.id,i.role,i.approved<>0,'all' FROM input i JOIN added a ON a.id=i.id",
          )
          .run(id, name, firstAdmin ? "admin" : "reader", Number(firstAdmin));
      }
      const user = (await get(id))!;

      return user;
    });
  }
  async function setRole(actor: ArchiveUser, id: string, role: Role) {
    return await db.transaction(async () => {
      if (actor.id !== "local" && (await get(actor.id))?.role !== "admin")
        throw new ForbiddenError(
          "Управлять доступом может только администратор",
        );
      if (!Object.hasOwn(ROLE_NAMES, role)) throw new Error("Неизвестная роль");
      const target = await get(id);
      if (!target) throw new Error("Пользователь не найден");
      if (
        db.kind === "postgres" &&
        role !== "admin" &&
        (await db
          .prepare("", "SELECT 1 FROM archive_owners WHERE user_id=?")
          .get(id))
      )
        throw new Error(
          "Нельзя понизить роль владельца архива. Сначала передайте владение.",
        );
      if (
        target.role === "admin" &&
        role !== "admin" &&
        (await adminCount()) <= 1
      )
        throw new Error("Нельзя убрать последнего администратора");
      await db
        .prepare(
          "UPDATE users SET role=?,approved=1,tree_access=CASE WHEN ?='admin' THEN 'all' ELSE tree_access END WHERE id=?",
          "UPDATE archive_memberships SET role=?,approved=true,tree_access=CASE WHEN ?='admin' THEN 'all' ELSE tree_access END WHERE user_id=?",
        )
        .run(role, role, id);
      if (target.role !== role || !target.approved)
        await audit.record(
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

      return (await get(id))!;
    });
  }
  async function setApproved(
    actor: ArchiveUser,
    id: string,
    approved: boolean,
  ) {
    return await db.transaction(async () => {
      if (actor.id !== "local" && (await get(actor.id))?.role !== "admin")
        throw new ForbiddenError(
          "Управлять доступом может только администратор",
        );
      const target = await get(id);
      if (!target) throw new Error("Пользователь не найден");
      if (target.role === "admin" && !approved)
        throw new Error("Нельзя заблокировать администратора");
      await db
        .prepare(
          "UPDATE users SET approved=? WHERE id=?",
          "UPDATE archive_memberships SET approved=(?::integer<>0) WHERE user_id=?",
        )
        .run(Number(approved), id);
      // PostgreSQL sessions identify an account across archives. Revoking one
      // membership must not sign it out of its other trees or account page.
      if (!approved && db.kind === "sqlite")
        await db
          .prepare(
            "DELETE FROM auth_sessions WHERE user_id=?",
            "DELETE FROM account_sessions WHERE user_id=?",
          )
          .run(id);
      return (await get(id))!;
    });
  }
  async function setIdentity(
    actor: ArchiveUser,
    id: string,
    personId: string | null,
    treeAccess: TreeAccess,
  ) {
    return await db.transaction(async () => {
      if (actor.id !== "local" && (await get(actor.id))?.role !== "admin")
        throw new ForbiddenError(
          "Управлять доступом может только администратор",
        );
      const target = await get(id);
      if (!target) throw new Error("Пользователь не найден");
      if (typeof personId !== "string" && personId !== null)
        throw new Error("Некорректный человек");
      if (
        personId &&
        !(await db
          .prepare(
            "SELECT 1 FROM people WHERE id=?",
            "SELECT 1 FROM people WHERE id=?",
          )
          .get(personId))
      )
        throw new Error("Человек не найден в древе");
      if (
        personId &&
        (await db
          .prepare(
            "SELECT 1 FROM users WHERE person_id=? AND id<>?",
            "SELECT 1 FROM runtime_users WHERE person_id=? AND id<>?",
          )
          .get(personId, id))
      )
        throw new Error("Этот человек уже связан с другим участником");
      if (!["all", "common_ancestors"].includes(treeAccess))
        throw new Error("Неизвестный режим доступа");
      if (treeAccess === "common_ancestors" && !personId)
        throw new Error(
          "Для доступа по общим предкам сначала выберите человека",
        );
      if (target.role === "admin" && treeAccess !== "all")
        throw new Error("Администратору нужен доступ ко всему древу");
      if (treeAccess === "common_ancestors") {
        const publicAccess = await db
          .prepare(
            "SELECT public_tree,public_albums FROM access_settings WHERE id=1",
            "SELECT public_tree,public_albums FROM runtime_access_settings WHERE id=1",
          )
          .get();
        if (publicAccess?.public_tree || publicAccess?.public_albums)
          throw new Error(
            "Для ограниченного доступа сначала закройте публичное древо и альбомы",
          );
      }
      await db
        .prepare(
          "UPDATE users SET person_id=?,tree_access=? WHERE id=?",
          "UPDATE archive_memberships SET person_id=?,tree_access=? WHERE user_id=?",
        )
        .run(personId || null, treeAccess, id);
      if (
        target.personId !== (personId || undefined) ||
        target.treeAccess !== treeAccess
      )
        await audit.record(
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
      const result = (await get(id))!;

      return result;
    });
  }
  async function listPage(limit: number, cursor?: string) {
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
      ? await db
          .prepare(
            "SELECT * FROM users WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?",
            "SELECT u.*, t.full_access FROM runtime_users u LEFT JOIN account_tiers t ON t.account_id=u.id WHERE (u.created_at,u.id)<(?,?) ORDER BY u.created_at DESC,u.id DESC LIMIT ?",
          )
          .all(after[0], after[1], limit + 1)
      : await db
          .prepare(
            "SELECT * FROM users ORDER BY created_at DESC,id DESC LIMIT ?",
            "SELECT u.*, t.full_access FROM runtime_users u LEFT JOIN account_tiers t ON t.account_id=u.id ORDER BY u.created_at DESC,u.id DESC LIMIT ?",
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
      total: Number(
        (await db
          .prepare(
            "SELECT count(*) AS n FROM users",
            "SELECT count(*) AS n FROM runtime_users",
          )
          .get())!.n,
      ),
    };
  }
  async function remove(actor: ArchiveUser, id: string) {
    return await db.transaction(async () => {
      if (actor.id !== "local" && (await get(actor.id))?.role !== "admin")
        throw new ForbiddenError(
          "Управлять доступом может только администратор",
        );
      if (actor.id === id)
        throw new Error("Нельзя удалить собственный аккаунт");
      const target = await get(id);
      if (!target) throw new Error("Пользователь не найден");
      if (
        db.kind === "postgres" &&
        (await db
          .prepare("", "SELECT 1 FROM archive_owners WHERE user_id=?")
          .get(id))
      )
        throw new Error(
          "Нельзя удалить владельца архива. Сначала передайте владение.",
        );
      if (target.role === "admin" && (await adminCount()) <= 1)
        throw new Error("Нельзя удалить последнего администратора");
      await audit.record(
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
      await db
        .prepare(
          "DELETE FROM user_tree_preferences WHERE user_id=?",
          "DELETE FROM user_tree_preferences WHERE user_id=?",
        )
        .run(id);
      await db
        .prepare(
          "DELETE FROM users WHERE id=?",
          "DELETE FROM archive_memberships WHERE user_id=?",
        )
        .run(id);
    });
  }
  async function setFullAccess(actor: ArchiveUser, id: string, enabled: boolean) {
    if (db.kind !== "postgres")
      throw new Error("Уровни аккаунтов доступны после перехода на PostgreSQL");
    return await db.transaction(async () => {
      if (
        !(actor.id === "local" && !process.env.PUBLIC_ORIGIN) &&
        !(await db
          .prepare("", "SELECT 1 FROM platform_admins WHERE account_id=?")
          .get(actor.id))
      )
        throw new ForbiddenError("Уровень аккаунта меняет администратор платформы");
      const target = await get(id);
      if (!target) throw new Error("Пользователь не найден");
      const current = await db
        .prepare(
          "",
          "SELECT full_access FROM account_tiers WHERE account_id=? FOR UPDATE",
        )
        .get(id);
      if (!current) throw new Error("Уровень аккаунта не найден");
      if (!!current.full_access === enabled) return target;
      await db
        .prepare(
          "",
          "UPDATE account_tiers SET full_access=?,changed_at=now() WHERE account_id=?",
        )
        .run(enabled ? "true" : "false", id);
      await audit.record(
        {
          action: "Изменён уровень аккаунта",
          entity: "user",
          entityId: id,
          label: target.name,
          personIds: target.personId ? [target.personId] : [],
          details: [
            {
              field: "Уровень",
              before: current.full_access ? "Полный" : "Базовый",
              after: enabled ? "Полный" : "Базовый",
            },
          ],
        },
        actor,
      );
      return (await get(id))!;
    });
  }
  return {
    get,
    recordVisit,
    register,
    setRole,
    setApproved,
    setIdentity,
    setFullAccess,
    listPage,
    remove,
    list: async () =>
      (
        await db
          .prepare(
            "SELECT * FROM users ORDER BY created_at,id",
            "SELECT u.*, t.full_access FROM runtime_users u LEFT JOIN account_tiers t ON t.account_id=u.id ORDER BY u.created_at,u.id",
          )
          .all()
      ).map(convert),
  };
}
