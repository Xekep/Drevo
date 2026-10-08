import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { MemberPreviewExit } from "./member-preview-exit";
export function EditorDialog({
  title,
  onClose,
  children,
  wide = false,
  inline = false,
  suspended = false,
  className = "",
  headerActions,
  dismissOnOutside = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  inline?: boolean;
  suspended?: boolean;
  className?: string;
  headerActions?: ReactNode;
  dismissOnOutside?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!inline) {
      if (suspended) dialog?.close();
      else dialog?.showModal();
      // Native close restores focus to the opener before the dialog is removed.
      return () => dialog?.close();
    }
  }, [inline, suspended]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dismissOnOutside || !dialog || inline) return;
    const press = (event: PointerEvent) => {
      const bounds = dialog.getBoundingClientRect();
      backdropPress.current = event.target === dialog &&
        (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom);
    };
    const click = (event: MouseEvent) => {
      if (backdropPress.current && event.target === dialog) onClose();
      backdropPress.current = false;
    };
    dialog.addEventListener("pointerdown", press);
    dialog.addEventListener("click", click);
    return () => {
      dialog.removeEventListener("pointerdown", press);
      dialog.removeEventListener("click", click);
    };
  }, [dismissOnOutside, inline, onClose]);
  if (inline)
    return (
      <section className={`inline-editor ${className}`} aria-label={title}>
        <header>
          <h2>{title}</h2>
          {headerActions}
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть редактор"
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    );
  return (
    <dialog
      ref={ref}
      className={`editor-dialog ${wide ? "wide" : ""} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      aria-label={title}
    >
      <MemberPreviewExit />
      <header>
        <h2>{title}</h2>
        {headerActions}
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
