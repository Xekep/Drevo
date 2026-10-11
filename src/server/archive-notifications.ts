import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveNotificationsPage } from "../shared/archive-notifications.ts";

/** Notifications expose current card names, never historical audit details. */
export function archiveNotificationsStore(db: StoreDatabase) {
  function eligible(userId: string, visible: ReadonlySet<string> | null) {
    const scope = visible ? [...visible] : null;
    const values = [
      userId,
      userId,
      userId,
      scope ? JSON.stringify(scope) : "null",
    ];
    const query = (postgres: boolean) => {
      const a = postgres ? "runtime_visible_audit_entries" : "audit_entries";
      const ap = postgres ? "archive_audit_people" : "audit_people";
      const c = postgres
        ? "archive_notification_cursors"
        : "notification_cursors";
      const r = postgres ? "archive_notification_reads" : "notification_reads";
      const sameArchive = postgres ? " AND ap.archive_id=a.archive_id" : "";
      return `SELECT a.id,a.at,a.actor_name,a.entity,p.id AS person_id,
        ${postgres ? "p.data->>'surname'" : "json_extract(p.data,'$.surname')"} AS surname,
        ${postgres ? "p.data->>'name'" : "json_extract(p.data,'$.name')"} AS name,
        ${postgres ? "p.data->>'patronymic'" : "json_extract(p.data,'$.patronymic')"} AS patronymic,
        CASE WHEN a.id<=COALESCE((SELECT read_through FROM ${c} WHERE user_id=?),0)
          OR EXISTS(SELECT 1 FROM ${r} WHERE user_id=? AND event_id=a.id) THEN 1 ELSE 0 END AS is_read
        FROM ${a} a JOIN people p ON ${postgres ? "p.archive_id=a.archive_id AND " : ""}
        p.id=CASE WHEN a.entity='people' THEN a.entity_id ELSE
          (SELECT person_id FROM ${ap} ap WHERE entry_id=a.id${sameArchive} ORDER BY person_id LIMIT 1) END
        WHERE a.actor_id<>? AND a.actor_id<>'system'
          AND ((a.entity='people' AND a.action='Добавлено') OR
            (a.entity='person_comment' AND a.action='Добавлено сообщение в обсуждение'
              AND EXISTS(SELECT 1 FROM ${postgres ? "runtime_visible_person_comments" : "person_comments"} pc
                WHERE ${postgres ? "pc.archive_id=a.archive_id AND " : ""}pc.id=CAST(CASE WHEN a.entity='person_comment' THEN a.entity_id ELSE '0' END AS BIGINT) AND pc.person_id=p.id)))
          AND ${scope ? `p.id IN (${postgres ? "SELECT jsonb_array_elements_text(?::jsonb)" : "SELECT value FROM json_each(?)"})` : "?='null'"}`;
    };
    return { sqlite: query(false), postgres: query(true), values };
  }
  return {
    async list(
      userId: string,
      visible: ReadonlySet<string> | null,
      before = 0,
    ): Promise<ArchiveNotificationsPage> {
      const q = eligible(userId, visible);
      const totals = await db
        .prepare(
          `SELECT count(*) AS unread,COALESCE(max(id),0) AS latest FROM (${q.sqlite}) n
            WHERE id>COALESCE((SELECT read_through FROM notification_cursors WHERE user_id=?),0)
              AND NOT EXISTS(SELECT 1 FROM notification_reads WHERE user_id=? AND event_id=n.id)`,
          `SELECT count(*) AS unread,COALESCE(max(id),0) AS latest FROM (${q.postgres}) n
            WHERE id>COALESCE((SELECT read_through FROM archive_notification_cursors WHERE user_id=?),0)
              AND NOT EXISTS(SELECT 1 FROM archive_notification_reads WHERE user_id=? AND event_id=n.id)`,
        )
        .get(...q.values, userId, userId);
      const rows = await db
        .prepare(
          `SELECT * FROM (${q.sqlite}) n WHERE (?=0 OR id<?) ORDER BY id DESC LIMIT 21`,
          `SELECT * FROM (${q.postgres}) n WHERE (?=0 OR id<?) ORDER BY id DESC LIMIT 21`,
        )
        .all(...q.values, before, before);
      const items = rows.slice(0, 20).map((row) => ({
        id: Number(row.id),
        at: String(row.at),
        kind:
          row.entity === "people"
            ? ("person_added" as const)
            : ("person_comment" as const),
        personId: String(row.person_id),
        personName:
          [row.surname, row.name, row.patronymic].filter(Boolean).join(" ") ||
          "Без имени",
        actorName: String(row.actor_name),
        read: Number(row.is_read) === 1,
      }));
      return {
        items,
        unread: Number(totals?.unread || 0),
        latest: Number(totals?.latest || 0),
        next: rows.length > 20 ? items.at(-1)!.id : null,
      };
    },
    async read(
      userId: string,
      visible: ReadonlySet<string> | null,
      id: number,
    ) {
      const q = eligible(userId, visible);
      if (
        !(await db
          .prepare(
            `SELECT 1 FROM (${q.sqlite}) n WHERE id=?`,
            `SELECT 1 FROM (${q.postgres}) n WHERE id=?`,
          )
          .get(...q.values, id))
      )
        return false;
      await db
        .prepare(
          "INSERT INTO notification_reads(user_id,event_id) VALUES(?,?) ON CONFLICT DO NOTHING",
          "INSERT INTO archive_notification_reads(user_id,event_id) VALUES(?,?) ON CONFLICT DO NOTHING",
        )
        .run(userId, id);
      return true;
    },
    async readThrough(
      userId: string,
      visible: ReadonlySet<string> | null,
      id: number,
    ) {
      const { latest } = await this.list(userId, visible);
      const through = Math.min(id, latest);
      await db
        .prepare(
          `INSERT INTO notification_cursors(user_id,read_through) VALUES(?,?)
          ON CONFLICT(user_id) DO UPDATE SET read_through=max(read_through,excluded.read_through)`,
          `INSERT INTO archive_notification_cursors(user_id,read_through) VALUES(?,?)
          ON CONFLICT(archive_id,user_id) DO UPDATE SET read_through=GREATEST(archive_notification_cursors.read_through,excluded.read_through)`,
        )
        .run(userId, through);
      await db
        .prepare(
          "DELETE FROM notification_reads WHERE user_id=? AND event_id<=?",
          "DELETE FROM archive_notification_reads WHERE user_id=? AND event_id<=?",
        )
        .run(userId, through);
    },
  };
}
