import { Plus } from "lucide-react";

export type TreeCreateAtDraft = {
  id: string;
  type: "parent" | "child" | "spouse";
  x: number;
  y: number;
};

export function TreeCreateAt({
  draft,
  busy,
  personName,
  onAdd,
  onClose,
}: {
  draft: TreeCreateAtDraft | null;
  busy: boolean;
  personName?: string;
  onAdd: (id: string, type: TreeCreateAtDraft["type"]) => void;
  onClose: () => void;
}) {
  if (!draft) return null;
  return (
    <div className="tree-create-at" style={{ left: draft.x, top: draft.y }}>
      <button
        disabled={busy}
        onClick={() => {
          onAdd(draft.id, draft.type);
          onClose();
        }}
      >
        <Plus size={20} />
        <span>
          Добавить{" "}
          {draft.type === "parent"
            ? "родителя"
            : draft.type === "child"
              ? "ребёнка"
              : "супруга / супругу"}
          <small>Связь с {personName}</small>
        </span>
      </button>
    </div>
  );
}
