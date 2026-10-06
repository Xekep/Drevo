import nodemailer from "nodemailer";
import type { EmailAuthSettings } from "../shared/email-auth-settings.ts";

export type EmailSender = (to: string, subject: string, text: string) => Promise<void>;
export type SmtpConfiguration = EmailAuthSettings & { password: string };
export const validMailAddress = (value: string) =>
  value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);

export function validSmtpConfiguration(value: SmtpConfiguration) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(value.host) &&
    Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535 &&
    validMailAddress(value.from) && !!value.user && value.user.length <= 320 &&
    !/[\r\n\0]/.test(value.user) && !!value.password && value.password.length <= 2048;
}

export function environmentSmtpConfiguration(): SmtpConfiguration {
  return {
    enabled: process.env.EMAIL_AUTH_ENABLED === "1",
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    from: process.env.SMTP_FROM || "",
  };
}

export function smtpSender(settings: SmtpConfiguration): EmailSender {
  if (!validSmtpConfiguration(settings)) throw new RangeError("Некорректная конфигурация SMTP.");
  // Non-pooled transport closes each connection after delivery. Never allow
  // plaintext authentication or ignore certificate failures.
  return async (to, subject, text) => {
    const transport = nodemailer.createTransport({
      host: settings.host, port: settings.port,
      secure: settings.port === 465, requireTLS: settings.port !== 465,
      auth: { user: settings.user, pass: settings.password },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    });
    try { await transport.sendMail({ from: settings.from, to, subject, text }); }
    finally { transport.close(); }
  };
}
