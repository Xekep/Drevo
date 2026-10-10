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
import { ChevronDown, ChevronUp, X } from "lucide-react";
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
  label = "Выбранный объект",
  initialExpanded = true,
  suspended = false,
  allowExpand = true,
}: {
  children: ReactNode;
  onClose: () => void;
  editing?: boolean;
  label?: string;
  initialExpanded?: boolean;
  suspended?: boolean;
  allowExpand?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 899px)").matches,
  );
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const mobileSuspended = mobile && suspended;
  const ref = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const expand = useCallback(() => setExpanded(true), []);
  useDockSwipe(ref, heading, expanded || !allowExpand, !editing, onClose, expand, true);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 899px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobile || !expanded || mobileSuspended) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // This is a complementary panel: the global navigation stays available.
    node
      ?.querySelector<HTMLElement>("button,input,select,textarea,[tabindex]")
      ?.focus();
    return () => {
      previous?.focus?.({ preventScroll: true });
    };
  }, [mobile, expanded, mobileSuspended]);
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
        hidden={mobileSuspended}
        aria-label={label}
        data-editing={editing || undefined}
        onFocusCapture={(event) => {
          const target = event.target;
          // Browser focus scrolling does not account for our sticky save bar.
          // Run after native scrolling, using its actual height (including errors).
          requestAnimationFrame(() => {
            const dock = ref.current;
            if (!editing || !dock || !target.isConnected || document.activeElement !== target) return;
            const footer = dock.querySelector<HTMLElement>(".person-editor-form > footer");
            if (!footer || footer.contains(target)) return;
            const bounds = target.getBoundingClientRect();
            const bottom = Math.min(dock.getBoundingClientRect().bottom, footer.getBoundingClientRect().top) - 12;
            if (bounds.bottom > bottom) dock.scrollTop += bounds.bottom - bottom;
          });
        }}
      >
        {!(mobile && editing) && (
          <div
            ref={heading}
            className={`inspector-heading ${editing ? "is-editing" : ""}`}
          >
            <span>В СЕМЕЙНОМ АРХИВЕ</span>
            <div className="inspector-actions-slot" ref={setActionsHost} />
            {!expanded && allowExpand && (
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
            {mobile && expanded && !editing && (
              <button
                aria-label="Свернуть панель"
                onClick={() => setExpanded(false)}
              >
                <ChevronDown size={20} />
              </button>
            )}
            <button aria-label="Закрыть панель" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        )}
        {children}
      </aside>
    </ActionsHost.Provider>
  );
}
