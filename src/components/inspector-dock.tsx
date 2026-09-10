import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { ChevronUp, X } from "lucide-react";
import { useDockSwipe } from "../hooks/useDockSwipe";
export function InspectorDock({
  children,
  onClose,
  editing = false,
  initialExpanded = true,
}: {
  children: ReactNode;
  onClose: () => void;
  editing?: boolean;
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const ref = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const expand = useCallback(() => setExpanded(true), []);
  useDockSwipe(ref, heading, expanded, !editing, onClose, expand, true);
  useEffect(() => {
    if (document.activeElement?.matches(":focus-visible")) {
      const target =
        (editing
          ? ref.current?.querySelector<HTMLElement>(".name-entry input,select")
          : null) ||
        ref.current?.querySelector<HTMLElement>(
          ".inspector-heading > button,header button",
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
      <div
        ref={heading}
        className={`inspector-heading ${editing ? "is-editing" : ""}`}
      >
        <span>В СЕМЕЙНОМ АРХИВЕ</span>
        {!expanded && (
          <div className="dock-grip">
            <button
              aria-label="Развернуть панель"
              aria-expanded={false}
              onClick={expand}
            >
              <ChevronUp size={18} />
            </button>
          </div>
        )}
        <button aria-label="Закрыть панель" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </aside>
  );
}
