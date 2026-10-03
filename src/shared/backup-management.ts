export type BackupSettings = {
  enabled: boolean;
  intervalHours: number;
  keepCount: number;
  storage: "local" | "remote";
  remoteHost: string;
  remoteDirectory: string;
};

export type BackupRecord = {
  id: string;
  name: string;
  createdAt: string;
  size: number;
  sha256: string;
  storage: "local" | "remote";
  remoteHost: string;
  remoteDirectory: string;
};

export type RestorePreview = {
  token: string;
  title: string;
  people: number;
  photos: number;
  documents?: number;
  files: number;
  missing: number;
  currentCommentsLost: number;
  backupCommentsSkipped: number;
  currentPeople: number;
  currentPhotos: number;
};

export type BackupJob = {
  id: string;
  kind: "create" | "preview" | "check";
  state: "running" | "succeeded" | "failed";
  startedAt: string;
  error?: string;
  warning?: string;
  preview?: RestorePreview;
};

export type BackupStatus = {
  settings: BackupSettings;
  nextRunAt: string | null;
  localDirectory: string;
  sshConfig: string;
  records: BackupRecord[];
  total: number;
  job: BackupJob | null;
};
