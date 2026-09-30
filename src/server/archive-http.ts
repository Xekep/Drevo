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
import { offlinePackageHttp } from "./offline-package-http.ts";
import { coreHttp } from "./core-http.ts";
import { databaseBackupHttp } from "./database-backup-http.ts";
import { placesHttp } from "./places-http.ts";
import type { GeocodingStore } from "./geocoding.ts";
import { publicSharingHttp } from "./public-sharing-http.ts";
import { mediaHttp } from "./media-http.ts";
import { mediaUploadHttp } from "./media-upload-http.ts";
import { familyChangesHttp } from "./family-changes-http.ts";
import type { productionStaticHttp } from "./production-static-http.ts";
import { restoreHttp } from "./restore-http.ts";
import type { RestoreStore } from "./restore.ts";
import { faceDescriptorsHttp } from "./face-descriptors-http.ts";
import { mcpTokenStore } from "./mcp-tokens.ts";
import { adminMcpHttp } from "./admin-mcp-http.ts";
import { mcpHttp } from "./mcp-http.ts";
import { mcpUsageStore } from "./mcp-usage.ts";
import { aiResearchHttp } from "./ai-research-http.ts";
import { researchSuggestionStore } from "./research-suggestions.ts";
import { researchSuggestionsHttp } from "./research-suggestions-http.ts";
import { aiSettingsStore } from "./ai-settings.ts";
import { adminAiHttp } from "./admin-ai-http.ts";
import { aiUsageStore } from "./ai-usage.ts";
import { researchCatalogStore } from "./research-catalog.ts";
import { adminResearchResourcesHttp } from "./admin-research-resources-http.ts";
import { documentsHttp } from "./documents-http.ts";
import { personDiscussionHttp } from "./person-discussion-http.ts";
import { treePreferencesStore } from "./tree-preferences.ts";
import { treePreferencesHttp } from "./tree-preferences-http.ts";
import { publishedPeopleStore } from "./published-people.ts";
import { publishedPeopleHttp } from "./published-people-http.ts";

export async function archiveHttp({
  archive,
  auth,
  media,
  previewImage,
  visibility,
  publicOrigin,
  serveStatic,
  aiFetch,
  uploadsDirectory,
  geocoding,
  restores,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  visibility: Awaited<ReturnType<typeof settingsStore>>;
  publicOrigin?: string;
  serveStatic: ReturnType<typeof productionStaticHttp>;
  aiFetch?: typeof fetch;
  uploadsDirectory: string;
  geocoding: GeocodingStore;
  restores: RestoreStore;
}) {
  const tokens = mcpTokenStore(archive.db);
  const mcpUsage = mcpUsageStore(archive.db);
  const suggestions = researchSuggestionStore(archive.db);
  const aiSettings = await aiSettingsStore(archive.db);
  const aiUsage = aiUsageStore(archive.db);
  const researchCatalog = researchCatalogStore(archive.db);
  const treePreferences = treePreferencesStore(archive.db);
  const publishedPeople = publishedPeopleHttp({
    archive,
    auth,
    store: publishedPeopleStore(archive.db),
    publicOrigin,
  });
  const personalTreeSettings = treePreferencesHttp({
    auth,
    preferences: treePreferences,
    publicOrigin,
  });
  const core = coreHttp({ archive, auth, publicOrigin });
  const adminMcp = adminMcpHttp({
    auth,
    db: archive.db,
    tokens,
    usage: mcpUsage,
    publicOrigin,
  });
  const researchMcp = mcpHttp({
    archive,
    tokens,
    usage: mcpUsage,
    publicOrigin,
  });
  const researchAi = aiResearchHttp({
    archive,
    auth,
    suggestions,
    aiSettings,
    usage: aiUsage,
    media,
    previewImage,
    researchCatalog,
    publicOrigin,
    fetcher: aiFetch,
  });
  const researchSuggestions = researchSuggestionsHttp({
    archive,
    auth,
    suggestions,
    publicOrigin,
  });
  const adminAi = adminAiHttp({
    auth,
    db: archive.db,
    settings: aiSettings,
    usage: aiUsage,
    publicOrigin,
    fetcher: aiFetch,
  });
  const adminResearchResources = adminResearchResourcesHttp({
    auth,
    catalog: researchCatalog,
    publicOrigin,
  });
  const serveBackup = databaseBackupHttp({ archive, auth });
  const adminAccess = adminAccessHttp({
    auth,
    users: await userStore(archive.db),
    visibility,
    publicOrigin,
  });
  const archiveQuery = archiveQueryHttp({
    archive,
    auth,
    visibility,
    treePreferences,
    researchCatalog,
  });
  const offlinePackage = offlinePackageHttp({
    archive,
    auth,
    uploadsDirectory,
  });
  const documents = documentsHttp({
    archive,
    auth,
    media,
    uploadsDirectory,
    publicOrigin,
  });
  const personDiscussion = personDiscussionHttp({
    archive,
    auth,
    publicOrigin,
  });
  const places = placesHttp({
    archive,
    auth,
    visibility,
    geocoding,
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
      shares,
    });
  await shares.cleanup();
  const shareCleanupTimer = setInterval(
    () => {
      void shares.cleanup().catch(() => console.error("share_cleanup_failed"));
    },
    6 * 60 * 60 * 1000,
  );
  shareCleanupTimer.unref();
  const restore = restoreHttp({
    restores,
    auth,
    publicOrigin,
  });
  const saveChanges = familyChangesHttp({ archive, auth, publicOrigin });
  const uploadMedia = mediaUploadHttp({
    archive,
    auth,
    media,
    publicOrigin,
    uploadsDirectory,
  });
  const faceDescriptors = faceDescriptorsHttp({ archive, auth, publicOrigin });
  const serveMedia = mediaHttp({
    auth,
    media,
    previewImage,
    visibility,
    archive,
  });

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (await core(req, res, url)) return true;
    if (await serveBackup(req, res, url)) return true;
    if (await adminAccess(req, res, url)) return true;
    if (await adminMcp(req, res, url)) return true;
    if (await adminAi(req, res, url)) return true;
    if (await adminResearchResources(req, res, url)) return true;
    if (await personalTreeSettings(req, res, url)) return true;
    if (await archiveQuery(req, res, url)) return true;
    if (await offlinePackage(req, res, url)) return true;
    if (await documents(req, res, url)) return true;
    if (await personDiscussion(req, res, url)) return true;
    if (await places(req, res, url)) return true;
    if (await adminSharing(req, res, url)) return true;
    if (await publishedPeople(req, res, url)) return true;
    if (await restore(req, res, url)) return true;
    if (await saveChanges(req, res, url)) return true;
    if (await uploadMedia(req, res, url)) return true;
    if (await faceDescriptors(req, res, url)) return true;
    if (await researchAi(req, res, url)) return true;
    if (await researchSuggestions(req, res, url)) return true;
    if (await researchMcp(req, res, url)) return true;
    if (await serveMedia(req, res, url)) return true;
    if (await publicSharing(req, res, url)) return true;
    return await serveStatic(req, res, url);
  };
  return Object.assign(handle, {
    async close() {
      clearInterval(shareCleanupTimer);
      await researchAi.close();
    },
  });
}
