import { memo } from "react";
import type { Node } from "@xyflow/react";
export type HouseholdNodeType = Node<Record<string, never>, "household">;
export const HouseholdNode = memo(function HouseholdNode() {
  return <div className="flow-household" aria-hidden="true" />;
});
