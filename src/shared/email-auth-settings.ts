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
};

export type EmailAuthSettingsUpdate = EmailAuthSettings & {
  /** Omitted preserves the current secret; null explicitly removes it. */
  password?: string | null;
};
