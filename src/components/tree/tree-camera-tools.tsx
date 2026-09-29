import { Focus, Maximize2, Minus, Plus } from "lucide-react";
import { Panel, useReactFlow, useViewport } from "@xyflow/react";
import { PERSON_FOCUS_ZOOM } from "./use-tree-camera-state";

export function TreeCameraTools({
  selected,
  disabled,
}: {
  selected: string[];
  disabled: boolean;
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
        onClick={() => void flow.fitView({ padding: 0.2, maxZoom: 1 })}
      >
        <Maximize2 size={18} />
      </button>
      {selected.length > 0 && (
        <button
          disabled={disabled}
          title="К выбранному человеку"
          aria-label="К выбранному человеку"
          onClick={() => {
            void flow.fitView({
              nodes: selected.map((id) => ({ id })),
              minZoom: selected.length === 1 ? PERSON_FOCUS_ZOOM : 0.05,
              maxZoom: selected.length === 1 ? PERSON_FOCUS_ZOOM : 1,
              padding: 0.4,
              duration: window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches
                ? 0
                : 480,
              ease: (progress) => 1 - (1 - progress) ** 3,
            });
          }}
        >
          <Focus size={18} />
        </button>
      )}
    </Panel>
  );
}
