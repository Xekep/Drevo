import { useCallback, useRef } from "react";
import { confirmDiscardChanges } from "./useUnsavedChanges";

/** Each editor clears only its own draft, including when a second panel mounts. */
export function useNavigationChanges() {
  const dirtyForms = useRef(new Set<string>());
  const reportDirty = useCallback((form: string, dirty: boolean) => {
    if (dirty) dirtyForms.current.add(form);
    else dirtyForms.current.delete(form);
  }, []);
  const canLeave = useCallback(() => {
    if (!confirmDiscardChanges(dirtyForms.current.size > 0)) return false;
    dirtyForms.current.clear();
    return true;
  }, []);
  return { reportDirty, canLeave };
}
