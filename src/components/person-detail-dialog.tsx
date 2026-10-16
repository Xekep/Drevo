import { useRef, useState, type ReactNode } from "react";
import { EditorDialog } from "./editor-dialog";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";

/** A focused sub-editor. Its controls remain separate from the person save action. */
export function PersonDetailDialog({
  title,
  children,
  onApply,
  onClose,
  dirty = false,
  onDirtyChange,
}: {
  title: string;
  children: ReactNode;
  onApply: () => void;
  onClose: () => void;
  dirty?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  useUnsavedChanges(dirty, onDirtyChange);
  const body = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const apply = () => {
    const unnamed = body.current?.querySelector<HTMLInputElement>(
      '.source-repository-editor input[aria-invalid="true"]',
    );
    if (unnamed) {
      setError("Укажите название хранилища перед сохранением.");
      unnamed.focus();
      return;
    }
    const invalid = [
      ...(body.current?.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input, select, textarea") || []),
    ].find((field) => !field.checkValidity());
    if (invalid) {
      invalid.reportValidity();
      invalid.focus();
      return;
    }
    try {
      onApply();
      setError("");
    } catch (problem) {
      setError((problem as Error).message);
    }
  };
  return (
    <EditorDialog
      title={title}
      onClose={onClose}
      className="person-detail-dialog"
      onDialogKeyDown={(event) => {
        if ((event.target as Element).closest("dialog") !== event.currentTarget) return;
        if (
          event.key !== "Enter" ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          !(event.target instanceof HTMLInputElement)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (
          event.target.getAttribute("aria-expanded") !== "true" &&
          !event.target.closest(
            ".document-source-picker-list, .union-catalog-picker",
          ) &&
          event.target.type !== "search"
        )
          apply();
      }}
    >
      <div className="person-detail-body" ref={body}>
        {children}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="primary-action" onClick={apply}>
          Готово
        </button>
      </footer>
    </EditorDialog>
  );
}
