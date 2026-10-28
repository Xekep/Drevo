import type { TreeGenerationLimits } from "../domain/tree-preferences.ts";

/** Fragment membership is a revision-bound view, never an access capability. */
export type TreeFragmentRequest = TreeGenerationLimits & {
  expanded?: string[];
  offset?: number;
  /** Previous visible window prioritizes new neighbors; it never revokes IDs. */
  previous?: string[];
};

export type ArchiveTreeFragment = TreeFragmentRequest & {
  expanded: string[];
  hidden: Array<[string, number]>;
  atLimit: boolean;
  nextOffset: number;
  total: number;
  peopleIds: string[];
  threshold?: number;
  relationLabels?: Record<string, string>;
  referenceId?: string;
  stale?: boolean;
};

export type RemoteTreeFragment = {
  state: ArchiveTreeFragment | null;
  graphComplete?: boolean;
  load: (request: TreeFragmentRequest) => Promise<void>;
  ensureOverview: () => Promise<void>;
};
