import { useEffect } from "react";

export function confirmDiscardChanges(dirty: boolean) {
  return (
    !dirty ||
    window.confirm("Есть несохранённые изменения. Закрыть без сохранения?")
  );
}

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
