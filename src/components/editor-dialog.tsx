import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function EditorDialog({
  title,
  onClose,
  children,
  wide = false,
  inline = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  inline?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!inline) ref.current?.showModal();
  }, [inline]);
  if (inline)
    return (
      <section className="inline-editor" aria-label={title}>
        <header>
          <h2>{title}</h2>
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
      className={`editor-dialog ${wide ? "wide" : ""}`}
      onCancel={onClose}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
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
