import { useContext } from "react";
import { memberPreviewAt } from "../domain/archive-context.ts";
import { MemberPreviewName } from "./member-preview-context";

export function MemberPreviewBanner({ modal = false }: { modal?: boolean }) {
  const name = useContext(MemberPreviewName);
  const preview = typeof window === "undefined"
    ? null
    : memberPreviewAt(window.location.pathname);
  if (!preview) return null;
  return (
    <div className={`member-preview-banner${modal ? " is-modal" : ""}`} role="status">
      <span>Просмотр как участник{ name ? <>: <strong>{name}</strong></> : "" }</span>
      <a className={modal ? "member-preview-modal-exit" : undefined}
        href={`${preview.archiveId ? `/a/${preview.archiveId}` : ""}/manage`}>
        Выйти из просмотра
      </a>
    </div>
  );
}

/** Modal/fullscreen content needs its own banner inside the browser top layer. */
export function MemberPreviewExit() {
  return <MemberPreviewBanner modal />;
}
