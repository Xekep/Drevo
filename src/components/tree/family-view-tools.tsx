import { GitBranch, RotateCcw, Share2 } from "lucide-react";
import { fullName, type Person } from "../../domain";

export function FamilyViewTools({
  anchor,
  selected,
  count,
  total,
  changed,
  mode,
  onFamily,
  onCommon,
  onFan,
  fanActive,
  onAll,
  onReset,
  onShare,
}: {
  anchor?: Person;
  selected?: Person;
  count: number;
  total: number;
  changed: boolean;
  mode: "all" | "family" | "common";
  onFamily: () => void;
  onCommon: () => void;
  onFan: () => void;
  fanActive: boolean;
  onAll: () => void;
  onReset: () => void;
  onShare?: () => void;
}) {
  if (!anchor && !selected && !changed) return null;
  return (
    <div className="tree-family-row">
      <div className="tree-family-tools" aria-label="Область просмотра">
        {anchor && (
          <span
            className="tree-family-name"
            title={`${fanActive ? "Веер" : mode === "common" ? "Общие предки" : "Семья"}: ${fullName(anchor)}`}
          >
            <GitBranch size={15} />
            <span>
              {anchor.name} {anchor.surname}
            </span>
          </span>
        )}
        {anchor && !fanActive && (
          <span className="tree-family-count" role="status">
            {count} из {total}
          </span>
        )}
        {selected && (mode !== "family" || selected.id !== anchor?.id) && (
          <button
            onClick={onFamily}
            title={`Показать семью: ${fullName(selected)}`}
            aria-pressed={false}
          >
            Семья выбранного
          </button>
        )}
        {selected && (mode !== "common" || selected.id !== anchor?.id) && (
          <button
            onClick={onCommon}
            title={`Показать людей с общими предками: ${fullName(selected)}`}
            aria-pressed={false}
          >
            Общие предки
          </button>
        )}
        {(selected || anchor) && (
          <button
            type="button"
            onClick={onFan}
            aria-pressed={fanActive}
            title={
              fanActive
                ? "Вернуться к прежнему виду древа"
                : `Веер предков: ${fullName(selected || anchor!)}`
            }
          >
            {fanActive ? "Закрыть веер" : "Веер"}
          </button>
        )}
        {anchor && <button onClick={onAll}>Всё древо</button>}
        {anchor && onShare && (
          <button className="tree-family-share" onClick={onShare}>
            <Share2 size={15} aria-hidden="true" />
            <span>Поделиться</span>
          </button>
        )}
        {changed && (
          <button
            className="tree-family-reset"
            onClick={onReset}
            aria-label={
              mode === "family"
                ? "Вернуться к ближайшей семье"
                : "Развернуть все ветви"
            }
            title={
              mode === "family" ? "Ближайшая семья" : "Развернуть все ветви"
            }
          >
            <RotateCcw size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
