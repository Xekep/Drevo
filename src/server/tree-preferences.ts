import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../domain/tree-preferences.ts";

export function treePreferencesStore(db: DatabaseSync) {
  const lookup = db.prepare(
    "SELECT reverse_timeline,card_variant,color_scheme FROM user_tree_preferences WHERE user_id=?",
  );
  const save = db.prepare(`
    INSERT INTO user_tree_preferences(user_id,reverse_timeline,card_variant,color_scheme)
    VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      reverse_timeline=excluded.reverse_timeline,
      card_variant=excluded.card_variant,
      color_scheme=excluded.color_scheme
  `);
  function read(userId: string): TreePreferences {
    const row = lookup.get(userId);
    return row
      ? {
          reverseTimeline: !!row.reverse_timeline,
          cardVariant: row.card_variant as TreePreferences["cardVariant"],
          colorScheme: row.color_scheme as TreePreferences["colorScheme"],
        }
      : { ...DEFAULT_TREE_PREFERENCES };
  }
  return {
    read,
    write(userId: string, value: unknown): TreePreferences {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![2, 3].includes(Object.keys(value).length) ||
        Object.keys(value).some(
          (key) =>
            !["reverseTimeline", "cardVariant", "colorScheme"].includes(key),
        ) ||
        typeof (value as TreePreferences).reverseTimeline !== "boolean" ||
        !["classic", "portrait"].includes(
          (value as TreePreferences).cardVariant,
        ) ||
        ("colorScheme" in value &&
          !["warm", "white"].includes((value as TreePreferences).colorScheme))
      )
        throw new Error("Некорректные настройки древа");
      const preferences = value as TreePreferences;
      save.run(
        userId,
        Number(preferences.reverseTimeline),
        preferences.cardVariant,
        preferences.colorScheme || read(userId).colorScheme,
      );
      return read(userId);
    },
  };
}
