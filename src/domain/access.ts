export type Role = "admin" | "researcher" | "relative" | "reader";
export type TreeRole = "relative" | "reader";
export type GlobalRole = "admin" | "researcher" | null;
export type TreeAccess = "all" | "common_ancestors";
export type ArchiveUser = {
  id: string;
  name: string;
  role: Role;
  /** PostgreSQL archive grant. A platform role never supplies membership. */
  treeRole?: TreeRole;
  globalRole?: GlobalRole;
  archiveOwner?: boolean;
  createdAt: string;
  lastVisitAt?: string;
  approved?: boolean;
  personId?: string;
  treeAccess?: TreeAccess;
  platformAdmin?: boolean;
  fullAccess?: boolean;
  /** Effective AI access for the current archive; both viewer and owner tiers are required. */
  aiAvailable?: boolean;
};
export const ROLE_NAMES: Record<Role, string> = {
  admin: "Администратор",
  researcher: "Исследователь",
  relative: "Родственник",
  reader: "Читатель",
};
export const isArchiveOwner = (user: ArchiveUser | null | undefined) =>
  !!user && (user.archiveOwner ?? user.role === "admin");
export const canEditArchive = (user: ArchiveUser | null | undefined) =>
  !!user?.approved && (isArchiveOwner(user) ||
    (user.treeRole ?? user.role) !== "reader");
export const canAssessArchiveEvidence = (user: ArchiveUser | null | undefined) =>
  !!user?.approved && (user.globalRole !== undefined
    ? user.globalRole !== null && (user.treeRole ?? user.role) !== "reader"
    : user.role === "admin" || user.role === "researcher");
export const aiProfileRole = (user: ArchiveUser): Role =>
  user.treeRole === "reader" ? "reader" :
  user.globalRole || user.treeRole || user.role;
export const owns = (user: ArchiveUser | null, item: { createdBy?: string }) =>
  !!user &&
  (isArchiveOwner(user) ||
    (canEditArchive(user) && item.createdBy === user.id));
