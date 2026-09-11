import { useSyncExternalStore } from "react";

const DESKTOP_EDITING_QUERY =
  "(min-width: 900px) and (any-pointer: fine)";
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(DESKTOP_EDITING_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
/** Режим интерфейса; серверные права независимо проверяются по роли и авторству. */
export function useDesktopEditing() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_EDITING_QUERY).matches,
    () => false,
  );
}
