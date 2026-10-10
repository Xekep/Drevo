import {
  useLayoutEffect,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { useResearchAttachments } from "./use-research-attachments";

/** Desktop is a complementary workspace; the full mobile sheet is modal. */
export function ResearchPanelSurface({
  children,
  panel: panelRef,
  style,
  dragEvents,
  onClose,
  returnFocus,
}: {
  children: ReactNode;
  panel: RefObject<HTMLElement | null>;
  style?: CSSProperties;
  dragEvents: ReturnType<typeof useResearchAttachments>["dragEvents"];
  onClose: () => void;
  returnFocus: () => void;
}) {
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 600px)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(max-width: 600px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    if (node instanceof HTMLDialogElement) node.showModal();
    const initial = !mobile
      ? node.querySelector<HTMLElement>("textarea:not(:disabled)")
      : null;
    (initial || node.querySelector<HTMLElement>("[data-panel-heading]"))?.focus(
      { preventScroll: true },
    );
    return () => {
      if (node instanceof HTMLDialogElement) node.close();
      queueMicrotask(returnFocus);
    };
  }, [mobile, panelRef, returnFocus]);
  const shared = {
    ...dragEvents,
    ref: (node: HTMLElement | null) => {
      panelRef.current = node;
    },
    className: "research-assistant",
    "aria-label": "ИИ-исследователь",
    style,
  };
  if (!mobile) return <aside {...shared}>{children}</aside>;
  return (
    // Native modality owns background inertness; nested graph dialogs stay independent.
    <dialog
      {...shared}
      aria-modal="true"
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (
          event.key !== "Tab" ||
          !event.currentTarget.contains(event.target as Node)
        )
          return;
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
          ),
        ].filter(
          (item) =>
            item.getClientRects().length > 0 && !item.closest("[hidden]"),
        );
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next =
          index < 0
            ? event.shiftKey
              ? items.length - 1
              : 0
            : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
        items[next].focus({ preventScroll: true });
      }}
    >
      {children}
    </dialog>
  );
}
