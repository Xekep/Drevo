export type DiscoveryBranchRelation = "parent" | "child" | "spouse" |
  "grandparent" | "grandchild" | "sibling";

export const discoveryBranchRelationLabels: Record<DiscoveryBranchRelation,string> = {
  parent: "Родитель",
  child: "Ребёнок",
  spouse: "Супруг(а)",
  grandparent: "Предок (2 поколения)",
  grandchild: "Потомок (2 поколения)",
  sibling: "Брат или сестра",
};
