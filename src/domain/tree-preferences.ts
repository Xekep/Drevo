/** Kept in the wire format for older clients; only portrait is rendered. */
export type TreeCardVariant = "portrait";
export type TreeColorScheme = "warm" | "white";

export const ANCESTOR_GENERATIONS = [3, 4, 5, 6, 7] as const;
export const DESCENDANT_GENERATIONS = [1, 2, 3, 4, 5, 50] as const;
export const COLLATERAL_GENERATIONS = [0, 1, 2] as const;
export type TreeGenerationLimits = {
  anchorId: string;
  /** 7 means all recorded ancestors (the “7+” option). */
  ancestors: (typeof ANCESTOR_GENERATIONS)[number];
  descendants: (typeof DESCENDANT_GENERATIONS)[number];
  collateral: (typeof COLLATERAL_GENERATIONS)[number];
};

export function isTreeGenerationLimits(
  value: unknown,
): value is TreeGenerationLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as TreeGenerationLimits;
  return (
    Object.keys(value).length === 4 &&
    typeof fields.anchorId === "string" &&
    fields.anchorId.length > 0 &&
    fields.anchorId.length <= 200 &&
    ANCESTOR_GENERATIONS.some((n) => n === fields.ancestors) &&
    DESCENDANT_GENERATIONS.some((n) => n === fields.descendants) &&
    COLLATERAL_GENERATIONS.some((n) => n === fields.collateral)
  );
}

export type TreePreferences = {
  reverseTimeline: boolean;
  cardVariant: TreeCardVariant;
  colorScheme: TreeColorScheme;
  /** Missing/null retains the complete view, including disconnected people. */
  generationLimits?: TreeGenerationLimits | null;
};

export const DEFAULT_TREE_PREFERENCES: TreePreferences = {
  reverseTimeline: false,
  cardVariant: "portrait",
  colorScheme: "warm",
};

export function withGenerationAnchor(
  preferences: TreePreferences,
  anchorId: string,
): TreePreferences {
  return {
    ...preferences,
    generationLimits: {
      ancestors: 3,
      descendants: 3,
      collateral: 1,
      ...preferences.generationLimits,
      anchorId,
    },
  };
}
