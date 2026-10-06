import { useEffect, useRef } from "react";
import { GitBranch, RotateCcw, Share2 } from "lucide-react";
import { fullName, type Person } from "../../domain";

export function FamilyViewTools({
  compact = false,
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
  compact?: boolean;
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
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!compact) return;
    const closeOutside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node))
        menu.current.open = false;
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [compact]);
  function runAction(action: () => void) {
    action();
    if (menu.current) {
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    }
  }
  if (!anchor && !selected && !changed) return null;
  const controls = (
    <div
      className="tree-family-tools"
      aria-label={compact ? "Действия с семьёй" : "Область просмотра"}
    >
      {anchor && (
        <span
          className="tree-family-name"
          title={`${fanActive ? "Веер" : mode === "common" ? "Кровные" : "Близкие"}: ${fullName(anchor)}`}
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
          onClick={() => runAction(onFamily)}
          title={"Близкие родственники\n\nЭто родственники, которые близки в генеалогическом древе."}
          aria-pressed={false}
        >
          Близкие
        </button>
      )}
      {selected && (mode !== "common" || selected.id !== anchor?.id) && (
        <button
          onClick={() => runAction(onCommon)}
          title={"Кровные родственники\n\nРодственники, с которыми есть кровное родство, их предки и партнеры (муж/жена)."}
          aria-pressed={false}
        >
          Кровные
        </button>
      )}
      {!fanActive && (selected || anchor) && (
        <button
          type="button"
          onClick={() => runAction(onFan)}
          aria-pressed={false}
          title={"Веер предков\n\nПредки выбранного человека по поколениям в виде полукруга."}
        >
          Веер
        </button>
      )}
      {anchor && <button onClick={() => runAction(onAll)}>Всё древо</button>}
      {anchor && onShare && (
        <button
          className="tree-family-share"
          onClick={() => runAction(onShare)}
        >
          <Share2 size={15} aria-hidden="true" />
          <span>Поделиться</span>
        </button>
      )}
      {changed && (
        <button
          className="tree-family-reset"
          onClick={() => runAction(onReset)}
          aria-label={
            mode === "family"
              ? "Вернуться к ближайшей семье"
              : "Развернуть все ветви"
          }
          title={mode === "family" ? "Ближайшая семья" : "Развернуть все ветви"}
        >
          <RotateCcw size={16} />
        </button>
      )}
    </div>
  );
  if (compact)
    return (
      <details className="tree-family-menu" ref={menu}>
        <summary
          aria-label="Область просмотра"
          title="Близкие, кровные и веер"
        >
          <GitBranch size={19} aria-hidden="true" />
        </summary>
        <div className="tree-family-menu-content">{controls}</div>
      </details>
    );
  return <div className="tree-family-row">{controls}</div>;
}
