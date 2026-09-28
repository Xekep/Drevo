export type TreeCardVariant = "classic" | "portrait";
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
