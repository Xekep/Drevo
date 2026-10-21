import type { StoreDatabase } from "./store-database.ts";
import { isFragmentThreshold } from "../domain/tree-fragment.ts";
import {
  DEFAULT_TREE_PREFERENCES,
  isTreeGenerationLimits,
  type TreePreferences,
} from "../domain/tree-preferences.ts";

export function treePreferencesStore(db: StoreDatabase) {
  const lookup = db.prepare(
    "SELECT reverse_timeline,card_variant,color_scheme,generation_limits,animate_on_load,presentation,fragment_threshold FROM user_tree_preferences WHERE user_id=?",
    "SELECT reverse_timeline,card_variant,color_scheme,generation_limits,animate_on_load,presentation,fragment_threshold FROM user_tree_preferences WHERE user_id=?",
  );
  const save = db.prepare(
    `
    INSERT INTO user_tree_preferences(user_id,reverse_timeline,card_variant,color_scheme,generation_limits,animate_on_load,presentation,fragment_threshold)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      reverse_timeline=excluded.reverse_timeline,
      card_variant=excluded.card_variant,
      color_scheme=excluded.color_scheme,
      generation_limits=excluded.generation_limits,
      animate_on_load=excluded.animate_on_load,
      presentation=excluded.presentation,
      fragment_threshold=excluded.fragment_threshold
  `,
    `INSERT INTO user_tree_preferences(user_id,reverse_timeline,card_variant,color_scheme,generation_limits,animate_on_load,presentation,fragment_threshold)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(archive_id,user_id) DO UPDATE SET
      reverse_timeline=excluded.reverse_timeline,card_variant=excluded.card_variant,
      color_scheme=excluded.color_scheme,generation_limits=excluded.generation_limits,
      animate_on_load=excluded.animate_on_load,presentation=excluded.presentation,
      fragment_threshold=excluded.fragment_threshold`,
  );
  async function read(userId: string): Promise<TreePreferences> {
    const row = await lookup.get(userId);
    const limits: unknown = row?.generation_limits
      ? JSON.parse(String(row.generation_limits))
      : null;
    return row
      ? {
          reverseTimeline: !!row.reverse_timeline,
          cardVariant: "portrait",
          colorScheme: row.color_scheme as TreePreferences["colorScheme"],
          animateOnLoad: !!row.animate_on_load,
          presentation: row.presentation === "depth" ? "depth" : "flat",
          ...(row.fragment_threshold !== null &&
          isFragmentThreshold(Number(row.fragment_threshold))
            ? { fragmentThreshold: Number(row.fragment_threshold) }
            : {}),
          ...(isTreeGenerationLimits(limits)
            ? { generationLimits: limits }
            : {}),
        }
      : { ...DEFAULT_TREE_PREFERENCES };
  }
  return {
    read,
    async write(userId: string, value: unknown): Promise<TreePreferences> {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![1, 2, 3, 4, 5, 6, 7].includes(Object.keys(value).length) ||
        Object.keys(value).some(
          (key) =>
            ![
              "reverseTimeline",
              "cardVariant",
              "colorScheme",
              "generationLimits",
              "animateOnLoad",
              "presentation",
              "fragmentThreshold",
            ].includes(key),
        ) ||
        typeof (value as TreePreferences).reverseTimeline !== "boolean" ||
        ("fragmentThreshold" in value &&
          !isFragmentThreshold(value.fragmentThreshold)) ||
        ("presentation" in value &&
          !["flat", "depth"].includes(String(value.presentation))) ||
        ("animateOnLoad" in value &&
          typeof value.animateOnLoad !== "boolean") ||
        ("cardVariant" in value &&
          !["classic", "portrait"].includes(String(value.cardVariant))) ||
        ("colorScheme" in value &&
          !["warm", "white"].includes(
            (value as TreePreferences).colorScheme,
          )) ||
        ("generationLimits" in value &&
          value.generationLimits !== null &&
          !isTreeGenerationLimits(value.generationLimits))
      )
        throw new Error("Некорректные настройки древа");
      const preferences = value as TreePreferences;
      const previous = await read(userId);
      const limits =
        "generationLimits" in preferences
          ? preferences.generationLimits
          : previous.generationLimits;
      await save.run(
        userId,
        Number(preferences.reverseTimeline),
        "portrait",
        preferences.colorScheme || previous.colorScheme,
        limits ? JSON.stringify(limits) : null,
        Number(preferences.animateOnLoad ?? previous.animateOnLoad ?? true),
        preferences.presentation ?? previous.presentation ?? "flat",
        preferences.fragmentThreshold ?? previous.fragmentThreshold ?? null,
      );
      return await read(userId);
    },
  };
}
