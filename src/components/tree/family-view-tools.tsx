import { GitBranch, RotateCcw } from "lucide-react";
import { fullName, type Person } from "../../domain";

export function FamilyViewTools({
  anchor,
  selected,
  count,
  total,
  changed,
  onFamily,
  onAll,
  onReset,
}: {
  anchor?: Person;
  selected?: Person;
  count: number;
  total: number;
  changed: boolean;
  onFamily: () => void;
  onAll: () => void;
  onReset: () => void;
}) {
  if (!anchor && !selected && !changed) return null;
  return (
    <div className="tree-family-row">
      <div className="tree-family-tools" aria-label="Область просмотра">
        {anchor && (
          <span
            className="tree-family-name"
            title={`Семья: ${fullName(anchor)}`}
          >
            <GitBranch size={15} />
            <span>
              {anchor.name} {anchor.surname}
            </span>
          </span>
        )}
        {anchor && (
          <span className="tree-family-count" role="status">
            {count} из {total}
          </span>
        )}
        {selected && (!anchor || selected.id !== anchor.id) && (
          <button
            onClick={onFamily}
            title={`Показать семью: ${fullName(selected)}`}
          >
            Семья выбранного
          </button>
        )}
        {anchor && <button onClick={onAll}>Всё древо</button>}
        {changed && (
          <button
            className="tree-family-reset"
            onClick={onReset}
            aria-label={
              anchor ? "Вернуться к ближайшей семье" : "Развернуть все ветви"
            }
            title={anchor ? "Ближайшая семья" : "Развернуть все ветви"}
          >
            <RotateCcw size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
