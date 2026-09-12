export type Role = "admin" | "relative" | "reader";
export type ArchiveUser = {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
  approved?: boolean;
};
export const ROLE_NAMES: Record<Role, string> = {
  admin: "Администратор",
  relative: "Родственник",
  reader: "Читатель",
};
export const owns = (user: ArchiveUser | null, item: { createdBy?: string }) =>
  !!user &&
  (user.role === "admin" ||
    (user.role === "relative" && item.createdBy === user.id));
