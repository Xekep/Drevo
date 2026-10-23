import type { FamilyLink } from "../../domain/types";
import type { TreeOptimization } from "../../domain/optimize-tree-layout";
import type {
  LayoutPerson,
  TreeGeometry,
  TreeMode,
} from "../../domain/tree-layout";

type LayoutWorkerInput = {
  people: LayoutPerson[];
  links: Pick<FamilyLink, "type" | "from" | "to">[];
  mode: TreeMode;
  reverse: boolean;
};

export type LayoutWorkerRequest = LayoutWorkerInput & {
  /** Старые production-worker тесты могут посылать сообщение без id. */
  requestId?: number;
  previousGeometry?: TreeGeometry;
  parallelCandidates?: boolean;
  optimizeDisplayed?: boolean;
};

export type TaggedLayoutWorkerResponse =
  | { requestId: number; geometry: TreeGeometry; optimization?: TreeOptimization }
  | { requestId: number; error: string };
