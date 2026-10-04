import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type {
  VkAuthSettings,
  VkAuthStatus,
} from "../shared/vk-auth-settings.ts";
import { auditStore } from "./audit.ts";
import { assertCurrentArchiveActor, ForbiddenError } from "./users.ts";
import { assertCurrentPlatformAdmin } from "./platform-access.ts";

const validClientId = (value: string) => /^[1-9][0-9]{0,19}$/.test(value);
export function vkAuthSettingsStore(
  db: StoreDatabase,
  origin?: string,
  environmentId = "",
) {
  const audit = auditStore(db);
  const lookup = db.prepare(
    "SELECT enabled,client_id FROM vk_auth_settings WHERE id=1",
    "SELECT enabled,client_id FROM platform_vk_auth_settings WHERE id=1",
  );
  async function read(): Promise<VkAuthStatus> {
    const saved = await lookup.get();
    const clientId = saved ? String(saved.client_id) : environmentId.trim();
    const enabled = saved ? !!saved.enabled : validClientId(clientId);
    return {
      enabled,
      clientId,
      available: !!origin && enabled && validClientId(clientId),
      callbackUrl: origin ? `${origin}/auth/vk/callback` : "",
    };
  }
  return {
    read,
    async write(value: unknown, actor: ArchiveUser | null,
      session?: { accountId: string; tokenHash: string }) {
      if (db.kind === "sqlite" && (actor?.role !== "admin" || !actor.approved))
        throw new ForbiddenError(
          "Настройки входа доступны только администратору",
        );
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new RangeError("Некорректные настройки VK");
      const input = value as VkAuthSettings;
      if (
        Object.keys(value).some(
          (key) => !["enabled", "clientId"].includes(key),
        ) ||
        typeof input.enabled !== "boolean" ||
        typeof input.clientId !== "string"
      )
        throw new RangeError("Укажите состояние входа и ID приложения");
      const clientId = input.clientId.trim();
      if (
        (clientId && !validClientId(clientId)) ||
        (input.enabled && !clientId)
      )
        throw new RangeError("Укажите числовой ID приложения VK ID");
      if (db.kind === "postgres") {
        if (!session || !db.postgresTransaction)
          throw new ForbiddenError("Нет прав на настройки входа");
        await db.postgresTransaction(async (client) => {
          await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
          await client.query(
            `INSERT INTO platform_vk_auth_settings(id,enabled,client_id)
             VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE
             SET enabled=excluded.enabled,client_id=excluded.client_id`,
            [Number(input.enabled), clientId],
          );
          await client.query(
            `INSERT INTO platform_config_audit(actor_id,action,item_id)
             VALUES($1,'vk_auth_changed','vk-auth')`,
            [session.accountId],
          );
        });
        return read();
      }
      await db.transaction(async () => {
        await assertCurrentArchiveActor(db, actor!);
        const before = await read();
        await db
          .prepare(
            "INSERT INTO vk_auth_settings(id,enabled,client_id) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,client_id=excluded.client_id",
            "INSERT INTO vk_auth_settings(id,enabled,client_id) VALUES(1,?,?) ON CONFLICT(archive_id,id) DO UPDATE SET enabled=excluded.enabled,client_id=excluded.client_id",
          )
          .run(Number(input.enabled), clientId);
        if (before.enabled !== input.enabled || before.clientId !== clientId)
          await audit.record(
            {
              action: "Изменён вход через VK",
              entity: "settings",
              entityId: "vk-auth",
              label: "Вход через VK",
              personIds: [],
              details: [
                {
                  field: "Вход включён",
                  before: before.enabled ? "Да" : "Нет",
                  after: input.enabled ? "Да" : "Нет",
                },
                {
                  field: "ID приложения",
                  before: before.clientId,
                  after: clientId,
                },
              ],
            },
            actor!,
          );
      });
      return read();
    },
  };
}
