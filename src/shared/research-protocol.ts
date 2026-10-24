import type { ResearchAnswerReference } from "../domain/research-answer.ts";
import type { TreeOptimizationGoal } from "../domain/optimize-tree-layout.ts";

/** A bounded UI snapshot, never an access-control scope. */
export type ResearchTreeViewContext = {
  mode: "generations" | "timeline" | "fan" | "depth";
  personIds: string[];
  filtered: boolean;
  fragment: boolean;
};

export function researchTreeViewContext(value: unknown): ResearchTreeViewContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.mode !== "string" || !["generations", "timeline", "fan", "depth"].includes(raw.mode) ||
      !Array.isArray(raw.personIds) || raw.personIds.length > 10000 ||
      !raw.personIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 200) ||
      typeof raw.filtered !== "boolean" || typeof raw.fragment !== "boolean") return undefined;
  return { mode: raw.mode as ResearchTreeViewContext["mode"], personIds: [...new Set(raw.personIds as string[])],
    filtered: raw.filtered, fragment: raw.fragment };
}

/** Commands emitted only after the server checks the user's visible archive. */
export type UiAction =
  | { type: "focus_people"; personIds: string[] }
  | { type: "filter_people"; personIds: string[]; label: string }
  | { type: "exclude_people"; personIds: string[]; label: string }
  | { type: "optimize_tree_layout"; goal?: TreeOptimizationGoal }
  | { type: "hide_review_people" }
  | { type: "open_person"; personId: string }
  | { type: "open_photo"; photoId: string }
  | { type: "zoom_in" | "zoom_out" };

export type ResearchFile = { name: string; url: string };

export type ResearchResult = {
  answer: string;
  references: ResearchAnswerReference[];
  suggestionIds: string[];
  uiActions: UiAction[];
  files: ResearchFile[];
};
