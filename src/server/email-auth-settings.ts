import type { StoreDatabase } from "./store-database.ts";
import type { EmailAuthSettingsUpdate, EmailAuthStatus } from "../shared/email-auth-settings.ts";
import { decryptAiSecret, encryptAiSecret } from "./ai-secret.ts";
import { assertCurrentPlatformAdmin } from "./platform-access.ts";
import { environmentSmtpConfiguration, smtpSender, validSmtpConfiguration,
  type SmtpConfiguration } from "./email-sender.ts";

type Session = { accountId: string; tokenHash: string };

export function emailAuthSettingsStore(db: StoreDatabase, origin?: string) {
  const supported = db.kind === "postgres" && !!db.postgresTransaction;
  async function configuration(): Promise<SmtpConfiguration> {
    const saved = supported ? await db.prepare("", "SELECT * FROM platform_email_auth_settings WHERE id=1").get() : null;
    if (!saved) return environmentSmtpConfiguration();
    return { enabled: !!saved.enabled, host: String(saved.host), port: Number(saved.port),
      user: String(saved.smtp_user), from: String(saved.sender),
      password: decryptAiSecret(db, String(saved.password_cipher)) };
  }
  function status(value: SmtpConfiguration): EmailAuthStatus {
    const { password, ...publicFields } = value;
    return { ...publicFields, hasPassword: !!password, supported,
      available: supported && !!origin && value.enabled && validSmtpConfiguration(value),
      origin: origin || "" };
  }
  async function read() {
    // A missing encryption key must not disclose ciphertext or break unrelated
    // login providers. An admin can replace the secret to recover the service.
    const saved = supported ? await db.prepare("", "SELECT * FROM platform_email_auth_settings WHERE id=1").get() : null;
    if (!saved) return status(environmentSmtpConfiguration());
    let password = "";
    try { password = decryptAiSecret(db, String(saved.password_cipher)); } catch { /* replacement required */ }
    return status({ enabled: !!saved.enabled, host: String(saved.host), port: Number(saved.port),
      user: String(saved.smtp_user), from: String(saved.sender), password });
  }
  return {
    read,
    async runtime() {
      try {
        const settings = await configuration();
        return status(settings).available ? { enabled: true, sender: smtpSender(settings) } : { enabled: false, sender: null };
      } catch { return { enabled: false, sender: null }; }
    },
    async write(value: unknown, session: Session) {
      if (!supported) throw new RangeError("Для настройки email-входа необходим PostgreSQL.");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("Некорректные настройки почты.");
      const input = value as EmailAuthSettingsUpdate;
      if (Object.keys(input).some((key) => !["enabled", "host", "port", "user", "from", "password"].includes(key)) ||
          typeof input.enabled !== "boolean" || typeof input.host !== "string" ||
          typeof input.user !== "string" || typeof input.from !== "string" ||
          !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 ||
          (input.password !== undefined && input.password !== null && typeof input.password !== "string"))
        throw new RangeError("Проверьте поля настройки почты.");
      if (input.host.length > 253 || input.user.length > 320 || input.from.length > 254 ||
          (input.password?.length || 0) > 2048 || /[\r\n\0]/.test(input.host + input.user + input.from))
        throw new RangeError("Проверьте поля настройки почты.");
      await db.postgresTransaction!(async (client) => {
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        await client.query("SELECT pg_advisory_xact_lock(186743296)");
        const row = (await client.query("SELECT * FROM platform_email_auth_settings WHERE id=1 FOR UPDATE")).rows[0];
        const oldCipher = row ? String(row.password_cipher) : "";
        let password = "";
        if (input.password !== undefined) password = input.password || "";
        else if (row) {
          try { password = decryptAiSecret(db, oldCipher); } catch { /* admin must replace unreadable secret */ }
        } else password = environmentSmtpConfiguration().password;
        const settings = { enabled: input.enabled, host: input.host.trim(), port: input.port,
          user: input.user.trim(), from: input.from.trim(), password };
        if (settings.enabled && (!origin || !validSmtpConfiguration(settings)))
          throw new RangeError("Для включения укажите домен сервера и все SMTP-параметры, включая пароль.");
        const cipher = input.password === undefined && row ? oldCipher : password ? encryptAiSecret(db, password) : "";
        await client.query(`INSERT INTO platform_email_auth_settings(id,enabled,host,port,smtp_user,sender,password_cipher)
          VALUES(1,$1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET
          enabled=excluded.enabled,host=excluded.host,port=excluded.port,smtp_user=excluded.smtp_user,
          sender=excluded.sender,password_cipher=excluded.password_cipher`,
          [settings.enabled, settings.host, settings.port, settings.user, settings.from, cipher]);
        await client.query(`INSERT INTO platform_config_audit(actor_id,action,item_id)
          VALUES($1,'email_auth_changed','email-auth')`, [session.accountId]);
      });
      return read();
    },
    async testSender(session: Session) {
      if (!supported) throw new RangeError("Для настройки email-входа необходим PostgreSQL.");
      return db.postgresTransaction!(async (client) => {
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        // Capture one authorized configuration; send outside the transaction.
        const row = (await client.query("SELECT * FROM platform_email_auth_settings WHERE id=1 FOR SHARE")).rows[0];
        const value = row ? { enabled: !!row.enabled, host: String(row.host), port: Number(row.port),
          user: String(row.smtp_user), from: String(row.sender), password: decryptAiSecret(db, String(row.password_cipher)) } : environmentSmtpConfiguration();
        if (!validSmtpConfiguration(value)) throw new RangeError("Сначала сохраните корректные SMTP-параметры.");
        await client.query(`INSERT INTO platform_config_audit(actor_id,action,item_id)
          VALUES($1,'email_auth_test_requested','email-auth')`, [session.accountId]);
        return smtpSender(value);
      });
    },
  };
}
