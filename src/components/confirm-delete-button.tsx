import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

export function ConfirmDeleteButton({
  className,
  label,
  confirmationLabel,
  disabled = false,
  onConfirm,
}: {
  className: string;
  label: string;
  confirmationLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);

  if (disabled && armed) setArmed(false);

  useEffect(() => {
    if (!armed) return;
    const cancel = () => setArmed(false);
    const outside = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node)) cancel();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const timer = window.setTimeout(cancel, 8000);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
    };
  }, [armed]);

  return (
    <button
      ref={button}
      type="button"
      className={className + (armed ? " is-confirming" : "")}
      disabled={disabled}
      aria-label={armed ? confirmationLabel : label}
      title={
        armed
          ? "Нажмите ещё раз для удаления. Escape или нажатие вне кнопки — отмена."
          : label
      }
      onBlur={() => setArmed(false)}
      onKeyDown={(event) => {
        if (event.repeat && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
        }
      }}
      onClick={(event) => {
        // A double click must not turn one accidental gesture into confirmation.
        if (event.detail > 1) return;
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? (
        <span role="status">Удалить?</span>
      ) : (
        <Trash2 size={16} aria-hidden="true" />
      )}
    </button>
  );
}
