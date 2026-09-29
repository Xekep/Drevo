export type Role = "admin" | "researcher" | "relative" | "reader";
export type TreeAccess = "all" | "common_ancestors";
export type ArchiveUser = {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
  lastVisitAt?: string;
  approved?: boolean;
  personId?: string;
  treeAccess?: TreeAccess;
  platformAdmin?: boolean;
};
export const ROLE_NAMES: Record<Role, string> = {
  admin: "Администратор",
  researcher: "Исследователь",
  relative: "Родственник",
  reader: "Читатель",
};
export const owns = (user: ArchiveUser | null, item: { createdBy?: string }) =>
  !!user &&
  (user.role === "admin" ||
    ((user.role === "relative" || user.role === "researcher") &&
      item.createdBy === user.id));
