import {
  useState,
  useRef,
  useEffect,
  useCallback,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronUp, X } from "lucide-react";
import { useDockSwipe } from "../hooks/useDockSwipe";
const ActionsHost = createContext<HTMLDivElement | null>(null);

export function InspectorActions({ children }: { children: ReactNode }) {
  const host = useContext(ActionsHost);
  return host ? createPortal(children, host) : children;
}
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
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
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
    <ActionsHost.Provider value={actionsHost}>
      <aside
        ref={ref}
        className={`inspector-dock ${expanded ? "expanded" : ""}`}
        aria-label="Выбранный объект"
        data-editing={editing || undefined}
      >
        <div
          ref={heading}
          className={`inspector-heading ${editing ? "is-editing" : ""}`}
        >
          <span>В СЕМЕЙНОМ АРХИВЕ</span>
          <div className="inspector-actions-slot" ref={setActionsHost} />
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
    </ActionsHost.Provider>
  );
}
