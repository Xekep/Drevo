import { useState, useRef, useEffect, type ReactNode } from "react";
import { ChevronsUpDown, X } from "lucide-react";
export function InspectorDock({
  children,
  onClose,
  editing = false,
}: {
  children: ReactNode;
  onClose: () => void;
  editing?: boolean;
}) {
  const [expanded, setExpanded] = useState(editing);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (document.activeElement?.matches(":focus-visible")) {
      const target =
        (editing
          ? ref.current?.querySelector<HTMLElement>(".name-entry input,select")
          : null) ||
        ref.current?.querySelector<HTMLElement>(
          ".inspector-heading button,header button",
        );
      target?.focus({ preventScroll: true });
    }
  }, [editing]);
  return (
    <aside
      ref={ref}
      className={`inspector-dock ${expanded ? "expanded" : ""}`}
      aria-label="Выбранный объект"
    >
      <div className="dock-grip">
        <button
          aria-label="Изменить высоту панели"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronsUpDown size={18} />
        </button>
      </div>
      {!editing && (
        <div className="inspector-heading">
          <span>В СЕМЕЙНОМ АРХИВЕ</span>
          <button aria-label="Закрыть панель" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
      )}
      {children}
    </aside>
  );
}
