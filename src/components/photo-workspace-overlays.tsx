import { lazy, Suspense } from "react";
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
  busy: boolean;
  save: (family: Family) => Promise<Family>;
  upload: (file: File, metadata?: PhotoMetadata) => Promise<Family>;
  onPerson: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export function PhotoWorkspaceOverlays({
  family,
  user,
  workspace,
  canEdit,
  busy,
  save,
  upload,
  onPerson,
  onDirtyChange,
}: Props) {
  const photo = workspace.photo;
  return (
    <>
      {workspace.uploadOpen && canEdit && (
        <Suspense fallback={null}>
          <PhotoUpload
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
            onNavigate={workspace.navigatePhoto}
            family={family}
            initialEditing={workspace.editPhotoId === photo.id}
            canEdit={canEdit && owns(user, photo)}
            canDelete={canEdit && isArchiveOwner(user)}
            busy={busy}
            save={save}
            onClose={workspace.closePhoto}
            onPerson={onPerson}
            currentUserPersonId={user?.personId}
            canLoadDocuments={user?.approved === true}
            onDirtyChange={onDirtyChange}
          />
        </Suspense>
      )}
    </>
  );
}
