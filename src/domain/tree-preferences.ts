export type TreeCardVariant = "classic" | "portrait";

export type TreePreferences = {
  reverseTimeline: boolean;
  cardVariant: TreeCardVariant;
};

export const DEFAULT_TREE_PREFERENCES: TreePreferences = {
  reverseTimeline: false,
  cardVariant: "classic",
};
