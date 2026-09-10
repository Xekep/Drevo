import type {
  ArchiveUser,
  Family,
  PhotoMetadata,
} from "../domain";
import { owns } from "../domain";
import { viewerPhotos } from "../domain/photo-albums";
import type { PhotoWorkspace } from "../hooks/usePhotoWorkspace";
import { PhotoUpload } from "./photo-upload";
import { PhotoViewer } from "./photo-viewer";

type Props = {
  family: Family;
  user: ArchiveUser | null;
  workspace: PhotoWorkspace;
  canEdit: boolean;
  busy: boolean;
  save: (family: Family) => Promise<Family>;
  upload: (file: File, metadata?: PhotoMetadata) => Promise<Family>;
  onUploaded: (id: string) => void;
  onPerson: (id: string) => void;
};

export function PhotoWorkspaceOverlays({
  family,
  user,
  workspace,
  canEdit,
  busy,
  save,
  upload,
  onUploaded,
  onPerson,
}: Props) {
  const photo = workspace.photo;
  return (
    <>
      {workspace.uploadOpen && canEdit && (
        <PhotoUpload
          initialFile={workspace.droppedFile}
          upload={upload}
          busy={busy}
          onClose={workspace.closeUpload}
          onUploaded={(id) => {
            workspace.uploaded(id);
            onUploaded(id);
          }}
        />
      )}
      {photo && (
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
          canDelete={canEdit && user?.role === "admin"}
          busy={busy}
          save={save}
          onClose={workspace.closePhoto}
          onPerson={(id) => {
            workspace.closePhoto();
            onPerson(id);
          }}
        />
      )}
    </>
  );
}
