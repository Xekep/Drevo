export type Role = "admin" | "researcher" | "relative" | "reader";
export type TreeRole = "relative" | "reader";
export type GlobalRole = "admin" | "researcher" | null;
/** common_ancestors is the persisted key for blood relatives and their partners. */
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
export const canManageTreeBackups = (user: ArchiveUser | null | undefined): user is ArchiveUser => {
  if (!user?.approved || !isArchiveOwner(user)) return false;
  const explicit = user.globalRole !== undefined || user.treeRole !== undefined ||
    user.archiveOwner !== undefined;
  return explicit
    ? user.globalRole === "admin" || user.globalRole === "researcher"
    : user.role === "admin";
};
export const canEditArchive = (user: ArchiveUser | null | undefined) =>
  !!user?.approved && (isArchiveOwner(user) ||
    (user.treeRole ?? user.role) !== "reader");
export const canAssessArchiveEvidence = (user: ArchiveUser | null | undefined) => {
  if (!user || user.approved === false) return false;
  const explicitGrants = user.treeRole !== undefined ||
    user.globalRole !== undefined || user.archiveOwner !== undefined;
  if (explicitGrants)
    return user.approved === true && !!user.globalRole &&
      (user.treeRole ?? user.role) !== "reader";
  // Trusted legacy domain fixtures and SQLite actors have only a local role.
  return user.role === "admin" || user.role === "researcher";
};
export const aiProfileRole = (user: ArchiveUser): Role =>
  user.treeRole === "reader" ? "reader" :
  user.globalRole || user.treeRole || user.role;
export const owns = (user: ArchiveUser | null, item: { createdBy?: string }) => {
  if (!user || user.approved === false) return false;
  const explicitGrants = user.treeRole !== undefined ||
    user.globalRole !== undefined || user.archiveOwner !== undefined;
  if (explicitGrants && user.approved !== true) return false;
  return isArchiveOwner(user) ||
    ((canEditArchive(user) || (!explicitGrants && user.role !== "reader")) &&
      item.createdBy === user.id);
};
