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
import { archiveInvitationsHttp } from "./archive-invitations-http.ts";
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
import { additionsImportHttp } from "./additions-import-http.ts";
import type { productionStaticHttp } from "./production-static-http.ts";
import { restoreHttp } from "./restore-http.ts";
import type { RestoreStore } from "./restore.ts";
import { faceDescriptorsHttp } from "./face-descriptors-http.ts";
import { mcpTokenStore } from "./mcp-tokens.ts";
import { adminMcpHttp } from "./admin-mcp-http.ts";
import { mcpHttp } from "./mcp-http.ts";
import { mcpUsageStore } from "./mcp-usage.ts";
import { aiResearchHttp } from "./ai-research-http.ts";
import type { AiProviderCleanup } from "./ai-provider-cleanup.ts";
import { researchSuggestionStore } from "./research-suggestions.ts";
import { researchSuggestionsHttp } from "./research-suggestions-http.ts";
import { aiSettingsStore } from "./ai-settings.ts";
import { adminAiHttp } from "./admin-ai-http.ts";
import { aiProviderCleanupHttp } from "./ai-provider-cleanup-http.ts";
import { aiUsageStore } from "./ai-usage.ts";
import { researchCatalogStore } from "./research-catalog.ts";
import { adminResearchResourcesHttp } from "./admin-research-resources-http.ts";
import { documentsHttp } from "./documents-http.ts";
import { pdfDocumentPages } from "./document-pdf.ts";
import { join } from "node:path";
import { personDiscussionHttp } from "./person-discussion-http.ts";
import { treePreferencesStore } from "./tree-preferences.ts";
import { treePreferencesHttp } from "./tree-preferences-http.ts";
import { publishedPeopleStore } from "./published-people.ts";
import { publishedPeopleHttp } from "./published-people-http.ts";
import { discoveryMatchesHttp } from "./discovery-matches-http.ts";
import { discoveryCardShareHttp } from "./discovery-card-share-http.ts";
import { discoveryBranchShareHttp } from "./discovery-branch-share-http.ts";

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
  selectedArchiveId,
  geocoding,
  restores,
  providerCleanup,
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
  selectedArchiveId?: string;
  geocoding: GeocodingStore;
  restores: RestoreStore;
  providerCleanup?: AiProviderCleanup;
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
  const discoveryMatches = discoveryMatchesHttp({ archive, auth, publicOrigin });
  const discoveryCardShare = discoveryCardShareHttp({ archive, auth, publicOrigin });
  const discoveryBranchShare = discoveryBranchShareHttp({ archive, auth, publicOrigin });
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
    uploadsDirectory,
    providerCleanup,
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
    providerCleanup,
    publicOrigin,
    fetcher: aiFetch,
  });
  const providerCleanupStatus = aiProviderCleanupHttp({ auth, db: archive.db,
    providerCleanup, publicOrigin });
  const adminResearchResources = adminResearchResourcesHttp({
    auth,
    catalog: researchCatalog,
    publicOrigin,
  });
  const serveBackup = databaseBackupHttp({ archive, auth });
  const adminAccess = adminAccessHttp({
    db: archive.db,
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
  const pdfPages = pdfDocumentPages(join(uploadsDirectory, ".reader-cache"));
  const documents = documentsHttp({
    archive,
    auth,
    media,
    uploadsDirectory,
    publicOrigin,
    pdfPages,
  });
  const personDiscussion = personDiscussionHttp({
    archive,
    auth,
    publicOrigin,
    uploadsDirectory,
    media,
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
      selectedArchiveId,
    }),
    invitations = archiveInvitationsHttp(archive.db, auth, publicOrigin),
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
    db: archive.db,
    publicOrigin,
  });
  const saveChanges = familyChangesHttp({ archive, auth, publicOrigin });
  const importAdditions = additionsImportHttp({ archive, auth, publicOrigin });
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
    pdfPages,
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
    if (await providerCleanupStatus(req, res, url)) return true;
    if (await adminResearchResources(req, res, url)) return true;
    if (await personalTreeSettings(req, res, url)) return true;
    if (await archiveQuery(req, res, url)) return true;
    if (await offlinePackage(req, res, url)) return true;
    if (await documents(req, res, url)) return true;
    if (await personDiscussion(req, res, url)) return true;
    if (await places(req, res, url)) return true;
    if (await adminSharing(req, res, url)) return true;
    if (await invitations(req, res, url)) return true;
    if (await publishedPeople(req, res, url)) return true;
    if (await discoveryCardShare(req, res, url)) return true;
    if (await discoveryBranchShare(req, res, url)) return true;
    if (await discoveryMatches(req, res, url)) return true;
    if (await restore(req, res, url)) return true;
    if (await saveChanges(req, res, url)) return true;
    if (await importAdditions(req, res, url)) return true;
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
      await researchMcp.close();
      await pdfPages.close();
    },
  });
}
