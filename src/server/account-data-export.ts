import type { StoreDatabase } from "./store-database.ts";

/** A consistent snapshot of the account's own profile and archive access. */
export function accountDataExport(db: StoreDatabase) {
  return {
    async read(accountId: string) {
      if (db.kind !== "postgres") return null;
      return await db.transaction(async () => {
        const profile = await db
          .prepare(
            "",
            `SELECT a.id,a.name,a.created_at,a.last_visit_at,t.full_access
             FROM accounts a JOIN account_tiers t ON t.account_id=a.id
             WHERE a.id=?`,
          )
          .get(accountId);
        if (!profile) return null;
        await db
          .prepare("", "SELECT set_config('drevo.account_id',?,true)")
          .get(accountId);
        const methods = await db
          .prepare(
            "",
            "SELECT provider FROM account_identities WHERE account_id=? ORDER BY provider",
          )
          .all(accountId);
        const email = await db
          .prepare(
            "",
            "SELECT email FROM account_email_credentials WHERE account_id=?",
          )
          .get(accountId);
        const memberships = await db
          .prepare(
            "",
            `SELECT m.archive_id,a.title,m.role,m.approved,m.tree_access,
                    (o.user_id IS NOT NULL) AS owned
             FROM archive_memberships m
             JOIN archives a ON a.id=m.archive_id
             LEFT JOIN archive_owners o
               ON o.archive_id=m.archive_id AND o.user_id=m.user_id
             WHERE m.user_id=?
             ORDER BY lower(a.title),a.id`,
          )
          .all(accountId);
        const archives = [];
        for (const membership of memberships) {
          await db
            .prepare("", "SELECT set_config('drevo.archive_id',?,true)")
            .get(String(membership.archive_id));
          const saved = await db
            .prepare(
              "",
              `SELECT reverse_timeline,card_variant,color_scheme,generation_limits
               FROM user_tree_preferences
               WHERE archive_id=? AND user_id=?`,
            )
            .get(String(membership.archive_id), accountId);
          archives.push({
            id: String(membership.archive_id),
            title: String(membership.title),
            role: String(membership.role),
            treeAccess: String(membership.tree_access),
            approved: membership.approved === true,
            owned: membership.owned === true,
            preferences: saved
              ? {
                  reverseTimeline: !!saved.reverse_timeline,
                  cardVariant: String(saved.card_variant),
                  colorScheme: String(saved.color_scheme),
                  generationLimits: saved.generation_limits
                    ? JSON.parse(String(saved.generation_limits))
                    : null,
                }
              : null,
          });
        }
        return {
          format: "drevo-account-data",
          version: 1,
          exportedAt: new Date().toISOString(),
          account: {
            id: String(profile.id),
            name: String(profile.name),
            createdAt: String(profile.created_at),
            lastVisitAt: profile.last_visit_at
              ? String(profile.last_visit_at)
              : null,
            fullAccess: profile.full_access === true,
            providers: methods
              .map((row) => String(row.provider))
              .filter((provider) => ["email", "vk", "yandex"].includes(provider)),
            verifiedEmail: email ? String(email.email) : null,
          },
          archives,
        };
      }, true);
    },
  };
}
