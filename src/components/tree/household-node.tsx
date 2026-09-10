import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
export type HouseholdNodeType = Node<
  { label?: string; reverse?: boolean },
  "household"
>;
export const HouseholdNode = memo(function HouseholdNode({
  data,
}: NodeProps<HouseholdNodeType>) {
  return (
    <div
      className={`flow-household ${data.label ? "flow-household--siblings" : ""}`}
      data-reverse={data.reverse || undefined}
      aria-hidden="true"
    >
      {data.label && <span>{data.label}</span>}
    </div>
  );
});
