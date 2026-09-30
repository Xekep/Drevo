import type { ResearchAnswerReference } from "../domain/research-answer.ts";

/** Commands emitted only after the server checks the user's visible archive. */
export type UiAction =
  | { type: "focus_people"; personIds: string[] }
  | { type: "filter_people"; personIds: string[]; label: string }
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
