import { createHash } from "node:crypto";
import type { ArchiveUser } from "../domain/access.ts";
import type { Family } from "../domain/types.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";

/** Keep chat visibility identical across the AI route and account export. */
export function aiChatAccessScope(user: ArchiveUser, family?: Family) {
  const identity = [user.role, user.treeAccess || "all", user.personId || ""];
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
