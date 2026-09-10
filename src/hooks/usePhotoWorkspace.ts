import { useCallback, useMemo, useState } from "react";
import type { Family } from "../domain";

export function usePhotoWorkspace(family: Family | null) {
  const [uploadOpen, setUploadOpen] = useState(false),
    [droppedFile, setDroppedFile] = useState<File | null>(null),
    [photoId, setPhotoId] = useState<string | null>(null),
    [photoCollection, setPhotoCollection] = useState<string[] | undefined>(),
    [editPhotoId, setEditPhotoId] = useState<string | null>(null),
    [personFilter, setPersonFilter] = useState<string | null>(null);

  const photo = useMemo(
    () => family?.photos?.find((item) => item.id === photoId),
    [family?.photos, photoId],
  );

  const openPhoto = useCallback((id: string, photoIds?: string[]) => {
    setEditPhotoId(null);
    setPhotoCollection(photoIds);
    setPhotoId(id);
  }, []);

  const navigatePhoto = useCallback((id: string) => {
    setEditPhotoId(null);
    setPhotoId(id);
  }, []);

  const closePhoto = useCallback(() => {
    setEditPhotoId(null);
    setPhotoId(null);
  }, []);

  const openUpload = useCallback((file?: File | null) => {
    setDroppedFile(file || null);
    setUploadOpen(true);
  }, []);

  const closeUpload = useCallback(() => {
    setUploadOpen(false);
    setDroppedFile(null);
  }, []);

  const uploaded = useCallback(
    (id: string) => {
      openPhoto(id);
      setEditPhotoId(id);
      setPersonFilter(null);
    },
    [openPhoto],
  );

  const filterPerson = useCallback((id: string) => setPersonFilter(id), []);
  const clearFilter = useCallback(() => setPersonFilter(null), []);

  const resetNavigation = useCallback(() => {
    setPersonFilter(null);
    setPhotoId(null);
    setEditPhotoId(null);
  }, []);

  return {
    uploadOpen,
    droppedFile,
    photo,
    photoCollection,
    editPhotoId,
    personFilter,
    openPhoto,
    navigatePhoto,
    closePhoto,
    openUpload,
    closeUpload,
    uploaded,
    filterPerson,
    clearFilter,
    resetNavigation,
  };
}

export type PhotoWorkspace = ReturnType<typeof usePhotoWorkspace>;
