import { createHash } from "node:crypto";
import { isArchiveOwner, type ArchiveUser } from "../domain/access.ts";
import type { Family } from "../domain/types.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";

/** Keep chat visibility identical across the AI route and account export. */
export function aiChatAccessScope(user: ArchiveUser, family?: Family) {
  const identity = [isArchiveOwner(user) ? "admin" : user.role,
    user.treeAccess || "all", user.personId || ""];
  if (!isScopedUser(user)) return JSON.stringify(identity);
  if (!family) throw new Error("A scoped chat requires the current family");
  const visible = projectFamilyForUser(family, user);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([
      visible.people.map((person) => person.id).sort(),
      (visible.photos || []).map((photo) => photo.id).sort(),
    ]))
    .digest("hex");
  return JSON.stringify([...identity, fingerprint]);
}

/** Historical role labels may remain readable only with today's same graph scope. */
export function aiChatAllowedScopes(user: ArchiveUser, family?: Family) {
  const current = aiChatAccessScope(user, family);
  const identity = JSON.parse(current) as string[];
  const scopes = [current];
  const localRole = user.treeRole ?? user.role;
  if (user.treeRole !== undefined && !isArchiveOwner(user) && localRole === "relative") {
    scopes.push(JSON.stringify(["researcher", ...identity.slice(1)]));
    // The old admin role bypassed common-ancestor scoping. Never alias its
    // full-tree history to a newly scoped member.
    if (identity[1] === "all" && identity.length === 3)
      scopes.push(JSON.stringify(["admin", ...identity.slice(1)]));
  }
  return [...new Set(scopes)];
}
