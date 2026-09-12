import {
  useState,
  useRef,
  useEffect,
  useCallback,
  createContext,
  useContext,
  type ReactNode,
} from "react";
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions -- the aside
   is a keyboard-modal dialog only in the responsive overlay state. */
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
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" &&
      window.matchMedia("(max-width: 899px)").matches,
  );
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const ref = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const expand = useCallback(() => setExpanded(true), []);
  useDockSwipe(ref, heading, expanded, !editing, onClose, expand, true);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 899px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobile || !expanded) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const siblings = node?.parentElement
      ? [...node.parentElement.children].filter((item) => item !== node)
      : [];
    for (const sibling of siblings) (sibling as HTMLElement).inert = true;
    node?.querySelector<HTMLElement>("button,input,select,textarea,[tabindex]")?.focus();
    return () => {
      for (const sibling of siblings) (sibling as HTMLElement).inert = false;
      previous?.focus?.({ preventScroll: true });
    };
  }, [mobile, expanded]);
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
        role={mobile && expanded ? "dialog" : undefined}
        aria-modal={mobile && expanded ? true : undefined}
        tabIndex={mobile && expanded ? -1 : undefined}
        onKeyDown={(event) => {
          if (!mobile || !expanded || event.key !== "Tab") return;
          const items = [...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
          ) || [])].filter((item) => !item.hidden);
          if (!items.length) return;
          const first = items[0], last = items.at(-1)!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
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
