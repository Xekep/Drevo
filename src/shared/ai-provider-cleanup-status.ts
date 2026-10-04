export type AiCleanupState = "binding" | "pending" | "leased" | "blocked";
export type AiCleanupFilter = "all" | "blocked";
export type AiCleanupFailure =
  | "snapshot_invalid"
  | "provider_auth"
  | "provider_rejected"
  | "provider_temporary"
  | "provider_network"
  | "unknown";
export type AiCleanupJobStatus = {
  id: string;
  kind: "conversation" | "input_file";
  state: AiCleanupState;
  attempts: number;
  updatedAt: number;
  nextAttemptAt: number | null;
  error: AiCleanupFailure | null;
  httpStatus?: number;
  canRetry: boolean;
};
export type AiCleanupStatus = {
  supported: boolean;
  checkedAt: number;
  counts: Record<AiCleanupState, number>;
  jobs: AiCleanupJobStatus[];
  nextCursor: string | null;
};
