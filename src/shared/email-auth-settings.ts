export type EmailAuthSettings = {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  from: string;
};

export type EmailAuthStatus = EmailAuthSettings & {
  hasPassword: boolean;
  available: boolean;
  supported: boolean;
  origin: string;
  captcha?: { enabled: boolean; siteKey: string; hasSecret: boolean };
};

export type EmailAuthSettingsUpdate = EmailAuthSettings & {
  /** Omitted preserves the current secret; null explicitly removes it. */
  password?: string | null;
  captcha?: { enabled: boolean; siteKey: string; secret?: string | null };
};

export type EmailCaptchaChallenge = {
  captchaRequired: true;
  siteKey: string;
};
