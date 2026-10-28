import type { StoreDatabase } from "./store-database.ts";
import type { EmailAuthSettingsUpdate, EmailAuthStatus } from "../shared/email-auth-settings.ts";
import { decryptAiSecret, encryptAiSecret } from "./ai-secret.ts";
import { assertCurrentPlatformAdmin } from "./platform-access.ts";
import { environmentSmtpConfiguration, smtpSender, validSmtpConfiguration,
  type SmtpConfiguration } from "./email-sender.ts";
import type { EmailCaptchaConfiguration } from "./email-captcha.ts";

type Session = { accountId: string; tokenHash: string };
const noCaptcha = (): EmailCaptchaConfiguration => ({ enabled: false, siteKey: "", secret: "" });
function captchaConfiguration(saved: Record<string, unknown>): EmailCaptchaConfiguration {
  return { enabled: saved.captcha_enabled === true, siteKey: String(saved.captcha_site_key || ""), secret: "" };
}

export function emailAuthSettingsStore(db: StoreDatabase, origin?: string) {
  const supported = db.kind === "postgres" && !!db.postgresTransaction;
  function status(value: SmtpConfiguration, captcha = noCaptcha()): EmailAuthStatus {
    const { password, ...publicFields } = value;
    return { ...publicFields, hasPassword: !!password, supported,
      available: supported && !!origin && value.enabled && validSmtpConfiguration(value) &&
        (!captcha.enabled || (!!captcha.siteKey && !!captcha.secret)),
      origin: origin || "", captcha: { enabled: captcha.enabled, siteKey: captcha.siteKey, hasSecret: !!captcha.secret } };
  }
  async function read() {
    // A missing encryption key must not disclose ciphertext or break unrelated
    // login providers. An admin can replace the secret to recover the service.
    const saved = supported ? await db.prepare("", "SELECT * FROM platform_email_auth_settings WHERE id=1").get() : null;
    if (!saved) return status(environmentSmtpConfiguration());
    let password = "";
    try { password = decryptAiSecret(db, String(saved.password_cipher)); } catch { /* replacement required */ }
    const captcha = captchaConfiguration(saved);
    try { captcha.secret = decryptAiSecret(db, String(saved.captcha_secret_cipher || "")); } catch { /* replacement required */ }
    return status({ enabled: !!saved.enabled, host: String(saved.host), port: Number(saved.port),
      user: String(saved.smtp_user), from: String(saved.sender), password }, captcha);
  }
  return {
    read,
    async runtime() {
      try {
        // Read SMTP and protection atomically from the same saved configuration.
        const row = supported ? await db.prepare("", "SELECT * FROM platform_email_auth_settings WHERE id=1").get() : null;
        const settings = row ? { enabled: !!row.enabled, host: String(row.host), port: Number(row.port),
          user: String(row.smtp_user), from: String(row.sender), password: decryptAiSecret(db, String(row.password_cipher)) } : environmentSmtpConfiguration();
        const captcha = row ? captchaConfiguration(row) : noCaptcha();
        if (captcha.enabled) captcha.secret = decryptAiSecret(db, String(row!.captcha_secret_cipher));
        if (!status(settings, captcha).available) return { enabled: false, sender: null };
        return { enabled: true, sender: smtpSender(settings), ...(captcha.enabled ? { captcha } : {}) };
      } catch { return { enabled: false, sender: null }; }
    },
    async write(value: unknown, session: Session) {
      if (!supported) throw new RangeError("Для настройки email-входа необходим PostgreSQL.");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("Некорректные настройки почты.");
      const input = value as EmailAuthSettingsUpdate;
      if (Object.keys(input).some((key) => !["enabled", "host", "port", "user", "from", "password", "captcha"].includes(key)) ||
          typeof input.enabled !== "boolean" || typeof input.host !== "string" ||
          typeof input.user !== "string" || typeof input.from !== "string" ||
          !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 ||
          (input.password !== undefined && input.password !== null && typeof input.password !== "string"))
        throw new RangeError("Проверьте поля настройки почты.");
      if (input.captcha !== undefined && (!input.captcha || typeof input.captcha !== "object" || Array.isArray(input.captcha) ||
          Object.keys(input.captcha).some((key) => !["enabled", "siteKey", "secret"].includes(key)) ||
          typeof input.captcha.enabled !== "boolean" || typeof input.captcha.siteKey !== "string" ||
          input.captcha.siteKey.length > 256 || !/^[A-Za-z0-9_-]*$/.test(input.captcha.siteKey) ||
          (input.captcha.secret !== undefined && input.captcha.secret !== null &&
            (typeof input.captcha.secret !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(input.captcha.secret)))))
        throw new RangeError("Проверьте ключи SmartCaptcha.");
      if (input.host.length > 253 || input.user.length > 320 || input.from.length > 254 ||
          (input.password?.length || 0) > 2048 || /[\r\n\0]/.test(input.host + input.user + input.from))
        throw new RangeError("Проверьте поля настройки почты.");
      await db.postgresTransaction!(async (client) => {
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        await client.query("SELECT pg_advisory_xact_lock(186743296)");
        const row = (await client.query("SELECT * FROM platform_email_auth_settings WHERE id=1 FOR UPDATE")).rows[0];
        const oldCipher = row ? String(row.password_cipher) : "";
        const captcha = row ? captchaConfiguration(row) : noCaptcha();
        let captchaCipher = String(row?.captcha_secret_cipher || "");
        if (input.captcha) {
          captcha.enabled = input.captcha.enabled;
          captcha.siteKey = input.captcha.siteKey;
          if (input.captcha.secret !== undefined)
            captchaCipher = input.captcha.secret ? encryptAiSecret(db, input.captcha.secret) : "";
          if (captcha.enabled) {
            let secret = "";
            try { secret = decryptAiSecret(db, captchaCipher); } catch { /* replacement required */ }
            if (!captcha.siteKey || !secret || !origin)
              throw new RangeError("Для включения SmartCaptcha укажите оба ключа и домен сервера.");
          }
        }
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
        await client.query(`INSERT INTO platform_email_auth_settings(id,enabled,host,port,smtp_user,sender,password_cipher,captcha_enabled,captcha_site_key,captcha_secret_cipher)
          VALUES(1,$1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET
          enabled=excluded.enabled,host=excluded.host,port=excluded.port,smtp_user=excluded.smtp_user,
          sender=excluded.sender,password_cipher=excluded.password_cipher,captcha_enabled=excluded.captcha_enabled,
          captcha_site_key=excluded.captcha_site_key,captcha_secret_cipher=excluded.captcha_secret_cipher`,
          [settings.enabled, settings.host, settings.port, settings.user, settings.from, cipher,captcha.enabled,captcha.siteKey,captchaCipher]);
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
