import { Focus, Maximize2, Minus, Plus } from "lucide-react";
import { Panel, useReactFlow, useViewport } from "@xyflow/react";
import type { FitTree } from "./tree-camera-fit.ts";

export function TreeCameraTools({
  selected,
  disabled,
  fitTree,
  onFocusSelected,
}: {
  selected: string[];
  disabled: boolean;
  fitTree: FitTree;
  onFocusSelected: () => void;
}) {
  const flow = useReactFlow(),
    { zoom } = useViewport();
  return (
    <Panel position="bottom-center" className="flow-camera-tools">
      <button
        aria-label="Уменьшить"
        disabled={disabled}
        onClick={() => void flow.zoomOut()}
      >
        <Minus size={18} />
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button
        aria-label="Увеличить"
        disabled={disabled}
        onClick={() => void flow.zoomIn()}
      >
        <Plus size={18} />
      </button>
      <i />
      <button
        disabled={disabled}
        title="Вписать видимую часть дерева"
        aria-label="Вписать видимую часть дерева"
        onClick={() => void fitTree({ padding: 0.2, maxZoom: 1 })}
      >
        <Maximize2 size={18} />
      </button>
      {selected.length > 0 && (
        <button
          disabled={disabled}
          title="К выбранному человеку"
          aria-label="К выбранному человеку"
          onClick={onFocusSelected}
        >
          <Focus size={18} />
        </button>
      )}
    </Panel>
  );
}
