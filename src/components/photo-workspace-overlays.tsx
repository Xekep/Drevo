import { lazy, Suspense, useEffect } from "react";
import type { ArchiveUser, Family, PhotoMetadata } from "../domain";
import { isArchiveOwner, owns } from "../domain";
import { viewerPhotos } from "../domain/photo-albums";
import type { PhotoWorkspace } from "../hooks/usePhotoWorkspace";

const PhotoUpload = lazy(() =>
  import("./photo-upload").then((module) => ({ default: module.PhotoUpload })),
);
const PhotoViewer = lazy(() =>
  import("./photo-viewer").then((module) => ({ default: module.PhotoViewer })),
);

type Props = {
  family: Family;
  user: ArchiveUser | null;
  workspace: PhotoWorkspace;
  canEdit: boolean;
  canUpload?: boolean;
  busy: boolean;
  save: (family: Family) => Promise<Family>;
  upload: (file: File, metadata?: PhotoMetadata) => Promise<Family>;
  onPerson: (id: string) => void;
  loadPersonDetails?: (id: string) => Promise<void>;
  hasPersonDetails?: (id: string) => boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export function PhotoWorkspaceOverlays({
  family,
  user,
  workspace,
  canEdit,
  canUpload = canEdit,
  busy,
  save,
  upload,
  onPerson,
  loadPersonDetails,
  hasPersonDetails,
  onDirtyChange,
}: Props) {
  const photo = workspace.photo;
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const dialog = document.querySelector<HTMLDialogElement>(
        ".photo-lightbox[open]",
      );
      if (
        !dialog ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.target instanceof HTMLElement &&
          dialog.contains(event.target) &&
          event.target.closest("input, textarea, select, [contenteditable=true]")) ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      dialog
        .querySelector<HTMLButtonElement>(
          event.key === "ArrowLeft" ? ".photo-previous" : ".photo-next",
        )
        ?.click();
    };
    document.addEventListener("keydown", keyDown, true);
    return () => document.removeEventListener("keydown", keyDown, true);
  }, []);
  return (
    <>
      {workspace.uploadOpen && canUpload && (
        <Suspense fallback={null}>
          <PhotoUpload
            canTag={canEdit}
            onDirtyChange={onDirtyChange}
            initialFile={workspace.droppedFile}
            upload={upload}
            busy={busy}
            onClose={workspace.closeUpload}
            onUploaded={(id) => {
              workspace.uploaded(id);
            }}
          />
        </Suspense>
      )}
      {photo && (
        <Suspense
          fallback={
            <div className="archive-loading-details" role="status">
              Открываем фотографию…
            </div>
          }
        >
          <PhotoViewer
            photo={photo}
            photos={viewerPhotos(
              family.photos || [],
              photo.id,
              workspace.photoCollection,
            )}
            photoIds={workspace.photoCollection}
            onNavigate={workspace.navigatePhoto}
            family={family}
            initialEditing={workspace.editPhotoId === photo.id}
            canEdit={canEdit && owns(user, photo)}
            canDelete={canEdit && isArchiveOwner(user)}
            busy={busy}
            save={save}
            onClose={workspace.closePhoto}
            onPerson={onPerson}
            loadPersonDetails={loadPersonDetails}
            hasPersonDetails={hasPersonDetails}
            currentUserPersonId={user?.personId}
            canLoadDocuments={user?.approved === true}
            onDirtyChange={onDirtyChange}
          />
        </Suspense>
      )}
    </>
  );
}
