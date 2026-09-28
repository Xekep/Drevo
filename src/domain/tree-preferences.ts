/** Kept in the wire format for older clients; only portrait is rendered. */
export type TreeCardVariant = "portrait";
export type TreeColorScheme = "warm" | "white";

export type TreePreferences = {
  reverseTimeline: boolean;
  cardVariant: TreeCardVariant;
  colorScheme: TreeColorScheme;
};

export const DEFAULT_TREE_PREFERENCES: TreePreferences = {
  reverseTimeline: false,
  cardVariant: "portrait",
  colorScheme: "warm",
};
