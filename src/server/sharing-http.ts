import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { mediaStore } from "./media.ts";
import type { imagePreviews } from "./image-previews.ts";
import type { settingsStore } from "./settings.ts";
import { userStore } from "./users.ts";
import { sharesStore } from "./shares.ts";
import { auditStore } from "./audit.ts";
import { adminAccessHttp } from "./admin-access-http.ts";
import { adminSharingHttp } from "./admin-sharing-http.ts";
import { archiveQueryHttp } from "./archive-query-http.ts";
import { coreHttp } from "./core-http.ts";
import { databaseBackupHttp } from "./database-backup-http.ts";
import { placesHttp } from "./places-http.ts";
import { currentGeocodingStore } from "./geocoding.ts";
import { publicSharingHttp } from "./public-sharing-http.ts";
import { mediaHttp } from "./media-http.ts";
import { mediaUploadHttp } from "./media-upload-http.ts";
import { familyChangesHttp } from "./family-changes-http.ts";
import type { productionStaticHttp } from "./production-static-http.ts";
import { restoreHttp } from "./restore-http.ts";
import { currentRestoreStore } from "./restore.ts";
import { faceDescriptorsHttp } from "./face-descriptors-http.ts";

export function sharingHttp({
  archive,
  auth,
  media,
  previewImage,
  visibility,
  publicOrigin,
  serveStatic,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  visibility: ReturnType<typeof settingsStore>;
  publicOrigin?: string;
  serveStatic: ReturnType<typeof productionStaticHttp>;
}) {
  const core = coreHttp({ archive, auth, publicOrigin });
  const serveBackup = databaseBackupHttp({ archive, auth });
  const adminAccess = adminAccessHttp({
    auth,
    users: userStore(archive.db),
    visibility,
    publicOrigin,
  });
  const archiveQuery = archiveQueryHttp({ archive, auth, visibility });
  const places = placesHttp({
    archive,
    auth,
    visibility,
    geocoding: () => currentGeocodingStore(archive.db),
    publicOrigin,
  });
  const shares = sharesStore(archive.db),
    audit = auditStore(archive.db),
    adminSharing = adminSharingHttp({
      archive,
      auth,
      shares,
      audit,
      publicOrigin,
    }),
    publicSharing = publicSharingHttp({
      archive,
      media,
      previewImage,
      visibility,
      shares,
    });
  const restore = restoreHttp({
    restores: () => currentRestoreStore(archive),
    auth,
    publicOrigin,
  });
  const saveChanges = familyChangesHttp({ archive, auth, publicOrigin });
  const uploadMedia = mediaUploadHttp({ archive, auth, media, publicOrigin });
  const faceDescriptors = faceDescriptorsHttp({ archive, auth, publicOrigin });
  const serveMedia = mediaHttp({ auth, media, previewImage, visibility });

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (await core(req, res, url)) return true;
    if (await serveBackup(req, res, url)) return true;
    if (await adminAccess(req, res, url)) return true;
    if (await archiveQuery(req, res, url)) return true;
    if (await places(req, res, url)) return true;
    if (await adminSharing(req, res, url)) return true;
    if (await restore(req, res, url)) return true;
    if (await saveChanges(req, res, url)) return true;
    if (await uploadMedia(req, res, url)) return true;
    if (await faceDescriptors(req, res, url)) return true;
    if (await serveMedia(req, res, url)) return true;
    if (await publicSharing(req, res, url)) return true;
    return await serveStatic(req, res, url);
  };
}
