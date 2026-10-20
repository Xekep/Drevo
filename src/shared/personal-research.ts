export type BookmarkTarget = {
  kind: "person" | "photo" | "document";
  id: string;
};
export type PersonalBookmark = BookmarkTarget & { label: string; href: string };
export type SavedPeopleFilter = {
  id: string;
  name: string;
  criteria: Record<string, unknown>;
};
export type AuditUndoPreview = {
  revision: number;
  currentRevision: number;
  changes: number;
  entries: Array<{ action: string; label: string }>;
  canUndo: boolean;
  reason?: string;
};
