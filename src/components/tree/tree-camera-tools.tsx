import { Focus, Maximize2, Minus, Plus } from "lucide-react";
import { Panel, useReactFlow, useViewport } from "@xyflow/react";

export function TreeCameraTools({ selected }: { selected: string[] }) {
  const flow = useReactFlow(),
    { zoom } = useViewport();
  return (
    <Panel position="bottom-center" className="flow-camera-tools">
      <button aria-label="Уменьшить" onClick={() => void flow.zoomOut()}>
        <Minus size={18} />
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button aria-label="Увеличить" onClick={() => void flow.zoomIn()}>
        <Plus size={18} />
      </button>
      <i />
      <button
        title="Вписать видимую часть дерева"
        aria-label="Вписать видимую часть дерева"
        onClick={() => void flow.fitView({ padding: 0.2, maxZoom: 1 })}
      >
        <Maximize2 size={18} />
      </button>
      <button
        disabled={!selected.length}
        title="К выбранному человеку"
        aria-label="К выбранному человеку"
        onClick={() =>
          void flow.fitView({
            nodes: selected.map((id) => ({ id })),
            maxZoom: 1,
            padding: 0.4,
          })
        }
      >
        <Focus size={18} />
      </button>
    </Panel>
  );
}
