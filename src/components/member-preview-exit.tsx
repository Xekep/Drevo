import { memberPreviewAt } from "../domain/archive-context.ts";

/** Native modal dialogs sit above the page banner in the browser top layer. */
export function MemberPreviewExit() {
  const preview = memberPreviewAt(window.location.pathname);
  if (!preview) return null;
  return (
    <a
      className="member-preview-modal-exit"
      href={`${preview.archiveId ? `/a/${preview.archiveId}` : ""}/manage`}
    >
      Выйти из просмотра
    </a>
  );
}
