import type { FamilyLink } from "../../domain/types";
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
};

export type TaggedLayoutWorkerResponse =
  | { requestId: number; geometry: TreeGeometry }
  | { requestId: number; error: string };
