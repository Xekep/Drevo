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
        {(!anchor || (selected && selected.id !== anchor.id)) && (
          <button
            onClick={onFamily}
            title={
              selected
                ? `Показать семью: ${fullName(selected)}`
                : "Показать ближайшую семью"
            }
          >
            {selected ? "Семья выбранного" : "Ближайшая семья"}
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
