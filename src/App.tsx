import { archiveFetch } from "./data/archive-fetch.ts";
import { canManageTreeBackups, isArchiveOwner } from "./domain/access.ts";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirmDiscardChanges } from "./hooks/useUnsavedChanges";
import { ArrowDownUp, ImagePlus, Link2, Plus, X } from "lucide-react";
import {
  analyzeKinship,
  suggestConnectionOrder,
  type Person,
  type GraphConnection,
  type ConnectionType,
} from "./domain";
import { useAccountSession } from "./hooks/useAccountSession";
import { useArchive } from "./hooks/useArchive";
import { useArchiveView } from "./hooks/useArchiveView";
import { useWorkspaceSelection } from "./hooks/useWorkspaceSelection";
import { usePhotoWorkspace } from "./hooks/usePhotoWorkspace";
import {
  archiveTargetAt,
  archiveTargetPath,
  type ArchiveTarget,
} from "./domain/archive-links";
import { archiveContextAt, memberPreviewAt, scopedArchivePath } from "./domain/archive-context.ts";
import { adminMatchSourcePath, archiveDocumentAt, archiveDocumentPath } from "./domain/archive-routes.ts";
import {
  ArchiveNavigation,
  ArchiveHeader,
  type ArchiveView,
} from "./components/archive-navigation";
import {
  TreeCanvas,
  type ConnectionDraft,
  type TreeCanvasHandle,
  type AssistantTreeFilter,
} from "./components/tree/tree-canvas";
import { InspectorDock } from "./components/inspector-dock";
import { PersonInspector } from "./components/person-inspector";
import { ConnectionInspector } from "./components/connection-inspector";
import { ComparisonPanel } from "./components/comparison-panel";
import { PersonEditor } from "./components/archive-editors";
import { ArchiveSection } from "./components/archive-section";
import { PhotoWorkspaceOverlays } from "./components/photo-workspace-overlays";
import { LoginButtons } from "./components/login-buttons";
import { AdminPanel } from "./components/admin-panel";
import { ArchiveSettings } from "./components/archive-settings";
import { TreePreferencesDialog } from "./components/tree-preferences-dialog";
import { MemberPreviewBanner } from "./components/member-preview-exit";
import { MemberPreviewName } from "./components/member-preview-context";
import { withGenerationAnchor } from "./domain/tree-preferences";
import { TreeExportDialog } from "./components/tree-export-dialog";
import { downloadVisibleGenealogy } from "./components/tree/visible-genealogy-download";
import { visibleGenealogyHasCatalogLinks } from "./domain/visible-genealogy-catalog-warning";
import { TreeImportDialog } from "./components/tree-import-dialog";
import { AboutProject } from "./components/about-project";
import { useDesktopEditing } from "./hooks/useDesktopEditing";
import { useArchivePublicationOwner } from "./hooks/useArchivePublicationOwner";
import { ConflictDialog } from "./components/conflict-dialog";
import { ShareDialog } from "./components/share-dialog";
import { PublishPersonDialog } from "./components/publish-person-dialog";
import { ArchiveLoading } from "./components/archive-loading";
import { ResearchAssistant } from "./components/research-assistant";
import { AccountPage } from "./components/account-page";
import { LazyChunkBoundary } from "./components/lazy-chunk-boundary";
import { loadLazyModule } from "./components/lazy-section-recovery";
const PlatformSettingsPage = lazy(() =>
  loadLazyModule(() => import("./components/platform-settings-page"), "platform-settings"));
import {
  clearEntrySequence,
  EntrySequence,
  shouldPlayEntrySequence,
} from "./components/entry-sequence";

type PersonDraft = {
  person?: Person;
  relative?: Person;
  type?: "child" | ConnectionType;
  bindSelf?: boolean;
  key: string;
};
const targetKey = (target: ArchiveTarget | null) =>
  target ? `${target.kind}:${target.id}` : "";
const galleryAlbumPath = (personId: string | null, year: string | null) => {
  const params = new URLSearchParams();
  if (personId) params.set("personId", personId);
  if (year) params.set("year", year);
  return `/photos${params.size ? `?${params}` : ""}`;
};


export default function App() {
  const participantPreview = memberPreviewAt(window.location.pathname);
  const previewActive = Boolean(participantPreview);
  const [emailAuthLink] = useState(() =>
    /^#email-(verify|reset|link)=[A-Za-z0-9_-]{43}$/.test(window.location.hash),
  );
  const [initialPersonLink] = useState(
    () =>
      archiveTargetAt(window.location.pathname, window.location.search)
        ?.kind === "person",
  );
  const [treeGrowing, setTreeGrowing] = useState(!initialPersonLink);
  const navigationDirty = useRef(false);
  const onPlatformSettingsDirtyChange = useCallback((dirty: boolean) => {
    navigationDirty.current = dirty;
  }, []);
  const [requestedView, setView, currentPath] = useArchiveView(
    useCallback(() => {
      const leave = confirmDiscardChanges(navigationDirty.current);
      if (leave) navigationDirty.current = false;
      return leave;
    }, []),
  );
  const archive = useArchive(requestedView !== "admin"),
    {
      family,
      user,
      busy,
      canEdit: allowedEdit,
      readTree,
      readPhotos,
      save: saveArchive,
      upload: uploadArchive,
      loadDetails,
      hasCollectionDetails,
      currentFamily,
      detailsSource,
      detailsGeneration,
      hasPersonDetails,
    } = archive;
  const desktop = useDesktopEditing(),
    canEdit = !participantPreview && allowedEdit;
  const publicationOwnership = useArchivePublicationOwner(
    !participantPreview && isArchiveOwner(user) ? user!.id : null,
    archiveContextAt(window.location.pathname)?.id || "",
    archive.local,
    Boolean(family) && !archive.loadingDetails,
  );
  const save = useCallback<typeof archive.save>(
    (data) => {
      if (!canEdit)
        return Promise.reject(
          new Error("Недостаточно прав для редактирования архива."),
        );
      return saveArchive(data);
    },
    [canEdit, saveArchive],
  );
  const upload = useCallback<typeof archive.upload>(
    (...args) => {
      if (!canEdit)
        return Promise.reject(new Error("Недостаточно прав для загрузки файла."));
      return uploadArchive(...args);
    },
    [canEdit, uploadArchive],
  );
  const selection = useWorkspaceSelection(),
    {
      selected,
      compare,
      selectionOnly,
      linkFrom,
      focus,
      spotlight,
      choose,
      reveal,
      revealFamily,
      dispatch,
    } = selection;
  const treeCanvas = useRef<TreeCanvasHandle>(null);
  const checkExportWarnings = useCallback(async (signal: AbortSignal) => {
    if (!family) return { parentEvidence: false, catalogLinks: false };
    await loadDetails({ collections: ["people"] });
    const current = currentFamily() || family;
    const visible = new Set(await treeCanvas.current!.visiblePersonIds(signal));
    return {
      parentEvidence: current.people.some((person) => visible.has(person.id) &&
        person.parentClaims?.some((claim) => visible.has(claim.parentId))),
      catalogLinks: visibleGenealogyHasCatalogLinks(current, visible),
    };
  }, [family, loadDetails, currentFamily]);
  const view =
    requestedView === "admin" || requestedView === "manage" || requestedView === "account"
      ? requestedView
      : requestedView === "places" && (readTree || readPhotos)
        ? "places"
        : !readTree
          ? "gallery"
          : requestedView === "gallery" && !readPhotos
            ? "tree"
            : requestedView;
  const [query, setQuery] = useState(""),
    [help, setHelp] = useState(false),
    [settings, setSettings] = useState(false),
    [treePreferencesOpen, setTreePreferencesOpen] = useState(false),
    [treeExportOpen, setTreeExportOpen] = useState(false),
    [treeImportOpen, setTreeImportOpen] = useState(false),
    [addMenu, setAddMenu] = useState(false),
    [notice, setNotice] = useState(""),
    [assistantOpen, setAssistantOpen] = useState(false),
    [assistantNudgeToken, setAssistantNudgeToken] = useState(0),
    [assistantZoom, setAssistantZoom] = useState<{
      token: number;
      direction: "in" | "out";
    }>({ token: 0, direction: "in" }),
    [assistantFilter, setAssistantFilter] = useState<AssistantTreeFilter | null>(null),
    [pendingResearchPersonId, setPendingResearchPersonId] = useState<
      string | null
    >(null);
  const { accountSession, accountLoading, accountError,
    restoredSessionState, restoredSessionDialog, validateRestoredSession,
    updateOwnRole, updateOwnTier } = useAccountSession({ archive, view, requestedView, previewActive });
  const [entryPending, setEntryPending] = useState(shouldPlayEntrySequence);
  useEffect(() => {
    const preventPageZoom = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault();
    };
    const preventPageSelectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a")
        return;
      const target = event.target;
      const editable =
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement &&
          ![
            "button",
            "checkbox",
            "color",
            "file",
            "hidden",
            "image",
            "radio",
            "range",
            "reset",
            "submit",
          ].includes(target.type)) ||
        (target instanceof Element &&
          !!target.closest('[contenteditable]:not([contenteditable="false"])'));
      if (!editable) event.preventDefault();
    };
    window.addEventListener("wheel", preventPageZoom, {
      capture: true,
      passive: false,
    });
    window.addEventListener("keydown", preventPageSelectAll, true);
    return () => {
      window.removeEventListener("wheel", preventPageZoom, true);
      window.removeEventListener("keydown", preventPageSelectAll, true);
    };
  }, []);
  const finishEntry = useCallback(() => {
    clearEntrySequence();
    setEntryPending(false);
  }, []);
  const [shareDraft, setShareDraft] = useState<{
    anchor: Person;
    people: Person[];
    revision: number;
  } | null>(null);
  const [publishPerson, setPublishPerson] = useState<Person | null>(null);
  const [publicationUpdate, setPublicationUpdate] = useState<{
    personId: string;
    published: boolean;
    archiveId: string | null;
  } | null>(null);
  const onPublicationStatus = useCallback((published: boolean) => {
    if (publishPerson) setPublicationUpdate({
      personId: publishPerson.id,
      published,
      archiveId: archiveContextAt(window.location.pathname)?.id || null,
    });
  }, [publishPerson]);
  const [personDraft, setPersonDraftState] = useState<PersonDraft | null>(null),
    [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(
      null,
    ),
    [preview, setPreview] = useState<ConnectionDraft | null>(null);
  const personDirty = useRef(false);
  const [connectionDirty, setConnectionDirty] = useState(false);
  const finishConnection = useCallback(() => {
    setConnectionDirty(false);
    setConnectionDraft(null);
    setPreview(null);
    navigationDirty.current = false;
  }, []);
  const closeConnection = useCallback(() => {
    if (busy || !confirmDiscardChanges(connectionDirty)) return false;
    finishConnection();
    return true;
  }, [busy, connectionDirty, finishConnection]);
  const onPersonDirtyChange = useCallback((dirty: boolean) => {
    personDirty.current = dirty;
    navigationDirty.current = dirty;
  }, []);
  const setPersonDraft = useCallback((next: PersonDraft | null) => {
    if (!confirmDiscardChanges(personDirty.current)) return false;
    personDirty.current = false;
    navigationDirty.current = false;
    setPersonDraftState(next);
    return true;
  }, []);
  const photoWorkspace = usePhotoWorkspace(family),
    { clearFilter } = photoWorkspace;
  const [urlVersion, setUrlVersion] = useState(0);
  const lastUrlTarget = useRef("");
  const photoReturnPath = useRef("/photos");
  const people = useMemo(() => family?.people || [], [family]);
  const map = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const [timelineDetails, setTimelineDetails] = useState(false);
  const loadPersonDetails = useCallback(
    (id: string) => {
      if (detailsGeneration === undefined) return Promise.resolve();
      return loadDetails({ people: [id] });
    },
    [loadDetails, detailsGeneration],
  );
  const archiveAvailable = !!family;
  const needsPeopleDetails = (view === "tree" && timelineDetails) || ["places", "insights", "quality"].includes(view);
  const needsPhotoDetails = ["gallery", "places", "insights", "quality"].includes(view);
  const loadViewDetails = useCallback(() => {
    const collections: Array<"people" | "photos"> = [];
    if (needsPeopleDetails) collections.push("people");
    if (needsPhotoDetails) collections.push("photos");
    return collections.length ? loadDetails({ collections }) : Promise.resolve();
  }, [needsPeopleDetails, needsPhotoDetails, loadDetails]);
  const retryViewDetails = () => {
    void loadViewDetails().catch((reason) =>
      setNotice(reason instanceof Error ? reason.message : "Не удалось загрузить сведения"));
  };
  useEffect(() => {
    if (!archiveAvailable) return;
    let active = true;
    void loadViewDetails().catch((reason) => {
      if (active)
        setNotice(
          reason instanceof Error
            ? reason.message
            : "Не удалось загрузить сведения",
        );
    });
    return () => {
      active = false;
    };
  }, [
    archiveAvailable,
    detailsSource,
    detailsGeneration,
    loadViewDetails,
  ]);
  useEffect(() => {
    if (!archiveAvailable || !selected.length) return;
    let active = true;
    void loadDetails({ people: selected.slice(0, 2) }).catch((reason) => {
      if (active)
        setNotice(
          reason instanceof Error
            ? reason.message
            : "Не удалось загрузить карточку",
        );
    });
    return () => {
      active = false;
    };
  }, [
    selected,
    archiveAvailable,
    detailsSource,
    detailsGeneration,
    loadDetails,
  ]);
  const openPersonPublication = useCallback((personId: string) => {
    setPublishPerson(map.get(personId) || null);
  }, [map]);
  const { openPhoto, navigatePhoto, closePhoto, uploaded } = photoWorkspace;
  useEffect(() => {
    if (!family || archive.loadingDetails) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const target = archiveTargetAt(
        window.location.pathname,
        window.location.search,
      );
      if (
        target?.kind === "photo" && !hasCollectionDetails("photos")) return;
      if (
        target &&
        window.location.pathname + window.location.search !==
          scopedArchivePath(archiveTargetPath(target))
      )
        setView(target.kind === "person" ? "tree" : "gallery", target, true);
      if (
        target &&
        !(target.kind === "person"
          ? readTree && map.has(target.id)
          : readPhotos &&
            family.photos?.some((photo) => photo.id === target.id))
      ) {
        setView(target.kind === "person" ? "tree" : "gallery", undefined, true);
        lastUrlTarget.current = "";
        setNotice(
          target.kind === "person"
            ? "Человек не найден или недоступен"
            : "Фотография не найдена или недоступна",
        );
        return;
      }
      const key = targetKey(target);
      if (key === lastUrlTarget.current) return;
      const previous = lastUrlTarget.current;
      lastUrlTarget.current = key;
      if (previous.startsWith("person:") && target?.kind !== "person")
        dispatch({ type: "clear" });
      if (previous.startsWith("photo:") && target?.kind !== "photo")
        closePhoto();
      if (target?.kind === "person") reveal([target.id]);
      if (target?.kind === "photo") openPhoto(target.id);
    });
    return () => {
      active = false;
    };
  }, [
    family,
    archive.loadingDetails,
    hasCollectionDetails,
    readTree,
    readPhotos,
    map,
    setView,
    reveal,
    dispatch,
    openPhoto,
    closePhoto,
    urlVersion,
  ]);
  const openPhotoUrl = useCallback(
    (id: string, ids?: string[]) => {
      const target: ArchiveTarget = { kind: "photo", id };
      photoReturnPath.current = currentPath.startsWith("/photos?")
        ? currentPath
        : "/photos";
      lastUrlTarget.current = targetKey(target);
      setView("gallery", target);
      openPhoto(id, ids);
    },
    [currentPath, openPhoto, setView],
  );
  const navigatePhotoUrl = useCallback(
    (id: string) => {
      const target: ArchiveTarget = { kind: "photo", id };
      lastUrlTarget.current = targetKey(target);
      setView("gallery", target, true);
      navigatePhoto(id);
    },
    [navigatePhoto, setView],
  );
  const closePhotoUrl = useCallback(() => {
    lastUrlTarget.current = "";
    setView("gallery", photoReturnPath.current, true);
    photoReturnPath.current = "/photos";
    closePhoto();
  }, [closePhoto, setView]);
  const uploadedPhoto = useCallback(
    (id: string) => {
      const target: ArchiveTarget = { kind: "photo", id };
      photoReturnPath.current = currentPath.startsWith("/photos?")
        ? currentPath
        : "/photos";
      lastUrlTarget.current = targetKey(target);
      setView("gallery", target);
      uploaded(id);
    },
    [currentPath, setView, uploaded],
  );
  const linkedPhotoWorkspace = {
    ...photoWorkspace,
    openPhoto: openPhotoUrl,
    navigatePhoto: navigatePhotoUrl,
    closePhoto: closePhotoUrl,
    uploaded: uploadedPhoto,
  };
  const selectGalleryAlbum = useCallback(
    (personId: string | null, year: string | null, replace = false) => {
      lastUrlTarget.current = "";
      setView("gallery", galleryAlbumPath(personId, year), replace);
    },
    [setView],
  );
  const selectDocument = useCallback(
    (id: string | null) => {
      const url = new URL(currentPath, window.location.origin);
      const personId = archiveDocumentAt(url.pathname)?.personId ||
        url.searchParams.get("personId");
      setView("documents", archiveDocumentPath(personId, id), !id);
    },
    [currentPath, setView],
  );
  const documentUrl = useMemo(
    () => new URL(currentPath, window.location.origin),
    [currentPath],
  );
  const documentRoute = useMemo(
    () => archiveDocumentAt(documentUrl.pathname),
    [documentUrl],
  );
  const documentPersonFilter = documentRoute?.personId ||
    documentUrl.searchParams.get("personId");
  const documentId = documentRoute?.documentId ||
    documentUrl.searchParams.get("documentId");
  useEffect(() => {
    if (!documentRoute ||
        (!documentUrl.searchParams.has("documentId") &&
         !documentUrl.searchParams.has("personId"))) return;
    if (documentId && !/^[a-f0-9-]{36}$/i.test(documentId)) return;
    setView("documents", archiveDocumentPath(documentPersonFilter, documentId), true);
  }, [currentPath, documentId, documentPersonFilter, documentRoute, documentUrl, setView]);
  const chosen = useMemo(
    () => selected.flatMap((id) => (map.has(id) ? [map.get(id)!] : [])),
    [selected, map],
  );
  const relation = useMemo(
    () =>
      chosen.length === 2
        ? analyzeKinship(chosen[0], chosen[1], people, family?.links, family?.unions)
        : null,
    [chosen, people, family?.links, family?.unions],
  );
  const highlighted = useMemo(() => relation?.path || [], [relation]);
  const navigate = useCallback(
    (next: ArchiveView) => {
      if (next !== view && personDraft && !setPersonDraft(null)) return;
      if (next !== view && connectionDraft && !closeConnection()) return;
      const target: ArchiveTarget | undefined =
        next === "tree" && selected.length === 1 && !compare && !selectionOnly
          ? { kind: "person", id: selected[0] }
          : undefined;
      lastUrlTarget.current = targetKey(target || null);
      setView(next, target);
      setAddMenu(false);
      clearFilter();
      closePhoto();
    },
    [
      setView,
      clearFilter,
      view,
      personDraft,
      setPersonDraft,
      connectionDraft,
      closeConnection,
      selected,
      compare,
      selectionOnly,
      closePhoto,
    ],
  );
  useEffect(() => {
    const sync = () => {
      setAddMenu(false);
      clearFilter();
      setUrlVersion((version) => version + 1);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [clearFilter]);
  const openConnection = useCallback(
    (draft: ConnectionDraft) => {
      if (!canEdit) return;
      if (!draft.original)
        draft = suggestConnectionOrder(draft, people, family?.links);
      if (!setPersonDraft(null)) return;
      if (!closeConnection()) return;
      setConnectionDraft(draft);
      setPreview(draft);
      lastUrlTarget.current = "";
      setView("tree", undefined, true);
      dispatch({ type: "finishLink" });
      setAddMenu(false);
    },
    [
      dispatch,
      canEdit,
      people,
      family?.links,
      setPersonDraft,
      closeConnection,
      setView,
    ],
  );
  const selectEdge = useCallback(
    (edge: GraphConnection) => {
      if (!setPersonDraft(null)) return;
      if (!closeConnection()) return;
      setConnectionDraft({ ...edge, original: edge });
      setPreview(null);
      lastUrlTarget.current = "";
      setView("tree", undefined, true);
      dispatch({ type: "finishLink" });
    },
    [dispatch, setPersonDraft, closeConnection, setView],
  );
  const choosePerson = useCallback(
    (id: string, additive = false) => {
      if (canEdit && linkFrom && linkFrom !== id) {
        openConnection({ from: linkFrom, to: id, type: "parent" });
        return;
      }
      if (!closeConnection()) return;
      choose(id, additive);
      if (additive || compare) {
        lastUrlTarget.current = "";
        setView("tree", undefined, true);
      } else {
        const target: ArchiveTarget = { kind: "person", id };
        lastUrlTarget.current = targetKey(target);
        setView("tree", target);
      }
    },
    [
      canEdit,
      linkFrom,
      openConnection,
      closeConnection,
      choose,
      compare,
      setView,
    ],
  );
  const selectPersonOnly = useCallback(
    (id: string) => {
      if (!closeConnection() || !setPersonDraft(null)) return;
      dispatch({ type: "selectOnly", id });
      lastUrlTarget.current = "";
      setView("tree", undefined, true);
    },
    [closeConnection, setPersonDraft, dispatch, setView],
  );
  const showPerson = useCallback(
    (id: string) => {
      if (!closeConnection()) return;
      const target: ArchiveTarget = { kind: "person", id };
      lastUrlTarget.current = targetKey(target);
      setView("tree", target);
      reveal([id]);
    },
    [reveal, closeConnection, setView],
  );
  useEffect(() => {
    if (!pendingResearchPersonId || archive.loadingDetails) return;
    if (!map.has(pendingResearchPersonId)) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      showPerson(pendingResearchPersonId);
      setPendingResearchPersonId(null);
    });
    return () => {
      active = false;
    };
  }, [pendingResearchPersonId, archive.loadingDetails, map, showPerson]);
  const clear = useCallback(() => {
    if (!personDraft && !connectionDraft) {
      dispatch({ type: "clear" });
      lastUrlTarget.current = "";
      setView("tree", undefined, true);
    }
  }, [dispatch, personDraft, connectionDraft, setView]);
  const clearPersonUrl = useCallback(() => {
    lastUrlTarget.current = "";
    setView("tree", undefined, true);
  }, [setView]);
  const openNewPerson = useCallback((bindSelf = false) => {
    if (!canEdit) return;
    if (!closeConnection()) return;
    if (!setPersonDraft({ key: crypto.randomUUID(), bindSelf })) return;
    setAddMenu(false);
    lastUrlTarget.current = "";
    setView("tree");
  }, [canEdit, closeConnection, setView, setPersonDraft]);
  const newPerson = useCallback(() => openNewPerson(), [openNewPerson]);
  const newSelf = useCallback(() => openNewPerson(true), [openNewPerson]);
  const startLink = useCallback(() => {
    if (!canEdit) return;
    if (!closeConnection()) return;
    if (!setPersonDraft(null)) return;
    dispatch({ type: "link" });
    setAddMenu(false);
    lastUrlTarget.current = "";
    setView("tree");
  }, [canEdit, closeConnection, dispatch, setView, setPersonDraft]);
  const updateConnection = useCallback((draft: ConnectionDraft) => {
    setConnectionDirty(true);
    navigationDirty.current = true;
    setConnectionDraft(draft);
    setPreview(draft);
  }, []);
  function closeEditor() {
    if (busy) return;
    setPersonDraft(null);
  }
  function relative(
    type: "child" | ConnectionType,
    existing: boolean,
    id?: string,
  ) {
    const p = id ? map.get(id) : chosen[0];
    if (!p || !canEdit) return;
    if (existing)
      openConnection({
        from: type === "child" ? p.id : "",
        to: type === "child" ? "" : p.id,
        type: type === "child" ? "parent" : type,
      });
    else setPersonDraft({ key: crypto.randomUUID(), relative: p, type });
  }
  const personEditor = family && personDraft && (
    <div hidden={!canEdit} inert={!canEdit}>
      <PersonEditor
        key={personDraft.key}
        inline
        suspended={!canEdit}
        isAdmin={isArchiveOwner(user)}
        user={user}
        family={family}
        person={personDraft.person}
        relativeTo={personDraft.relative}
        initialRelationship={personDraft.type}
        uploadPortrait={archive.uploadPortrait}
        save={save}
        busy={busy}
        onClose={closeEditor}
        onSaved={(id) => {
          showPerson(id);
          if (!personDraft.bindSelf || !user) return;
          void archiveFetch(`/api/users/${encodeURIComponent(user.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personId: id }),
          })
            .then(async (response) => {
              if (!response.ok) {
                const result = await response.json().catch(() => null);
                throw new Error(result?.error || "Не удалось связать карточку с аккаунтом.");
              }
              archive.reload();
            })
            .catch((error) =>
              setNotice(`Человек добавлен, но отметка «Это вы» не сохранилась: ${(error as Error).message}`),
            );
        }}
        onDirtyChange={onPersonDirtyChange}
      />
    </div>
  );
  const navigationUser =
    user || (view === "account" ? accountSession?.user : null) || null;
  const accountPerson = navigationUser?.personId
    ? family?.people.find((person) => person.id === navigationUser.personId)
    : undefined;
  return (
    <MemberPreviewName.Provider value={accountSession?.participantPreview?.name || user?.name || ""}>
    <div className={`archive-app${restoredSessionState === "ready" ? "" : " is-validating-restored-session"}`}>
      {shareDraft && (
        <ShareDialog {...shareDraft} onClose={() => setShareDraft(null)} />
      )}
      {publishPerson && (
        <PublishPersonDialog
          person={publishPerson}
          onClose={() => setPublishPerson(null)}
          onStatus={onPublicationStatus}
        />
      )}
      <div className="archive-main">
        <MemberPreviewBanner />
        {view === "admin" ? <header className="archive-header is-platform-header">
          <ArchiveNavigation
            view={view}
            onView={navigate}
            user={accountSession?.user || null}
            account={accountSession?.account}
            local={accountSession?.local === true}
            readTree={false}
            readPhotos={false}
            onHelp={() => setHelp(true)}
          />
        </header> : <ArchiveHeader
          navigation={
            <ArchiveNavigation
              view={view}
              onView={navigate}
              user={navigationUser}
              account={accountSession?.account}
              accountPerson={accountPerson}
              local={archive.local || accountSession?.local === true}
              readTree={readTree}
              readPhotos={readPhotos}
              onHelp={() => setHelp(true)}
              participantPreview={Boolean(participantPreview)}
              onTreePreferences={readTree ? () => setTreePreferencesOpen(true) : undefined}
              onPlatformLeave={() => {
                const leave = confirmDiscardChanges(navigationDirty.current);
                if (leave) navigationDirty.current = false;
                return leave;
              }}
            />
          }
          people={people}
          query={query}
          onQuery={setQuery}
          onSelect={showPerson}
          onSelectDocument={user?.approved || archive.local
            ? (id) => setView("documents", archiveDocumentPath(null, id))
            : undefined}
          busy={busy}
        />}
        {addMenu && canEdit && (
          <div className="archive-add-menu">
            <button onClick={newPerson}>
              <Plus size={18} />
              Человека
            </button>
            <button
              onClick={() => {
                photoWorkspace.openUpload();
                setAddMenu(false);
              }}
            >
              <ImagePlus size={18} />
              Фотографию
            </button>
            <button
              onClick={() => {
                openConnection({
                  from: selected[0] || "",
                  to: "",
                  type: "parent",
                });
                setView("tree");
              }}
            >
              <Link2 size={18} />
              Связь между людьми
            </button>
            <button onClick={() => setAddMenu(false)}>
              <X size={16} />
              Закрыть
            </button>
          </div>
        )}
        {emailAuthLink ? (
          <main className="archive-status">
            <LoginButtons />
          </main>
        ) : view === "account" ? (
          <AccountPage
            session={accountSession}
            loading={accountLoading}
            error={accountError}
            family={family}
            readTree={readTree}
            onPerson={showPerson}
            onAdmin={() => navigate("manage")}
            onPlatformAdmin={() => window.location.assign("/admin")}
          />
        ) : view === "admin" ? (
          accountLoading ? <main className="archive-status" role="status">Проверяем доступ к платформе…</main>
          : accountSession?.account?.globalRole === "admin" ||
              (!accountSession?.account && accountSession?.user?.platformAdmin === true) ? (
            <LazyChunkBoundary message="Админка платформы не загрузилась. Обновите страницу и повторите вход.">
              <Suspense fallback={<main className="archive-status" role="status">Загружаем админку платформы…</main>}>
                <PlatformSettingsPage accountId={(accountSession.account || accountSession.user)!.id}
                onDirtyChange={onPlatformSettingsDirtyChange}
                showRoles={Boolean(accountSession.account)}
                onOwnRoleChanged={(role) => {
                  updateOwnRole(role);
                  if (role !== "admin") navigate("account");
                }}
                onOwnTierChanged={(fullAccess) => {
                  updateOwnTier(fullAccess);
                }} />
              </Suspense>
            </LazyChunkBoundary>
          ) : <main className="archive-status">
            <h1>Админка платформы</h1>
            <p>Доступна только администратору платформы.</p>
            {!accountSession?.account && <LoginButtons />}
          </main>
        ) : family ? (
          <>
            {view === "manage" ? (
              (user && isArchiveOwner(user) && user.approved) ? (
                <AdminPanel
                  family={family}
                  currentUserId={user.id}
                  platformAdmin={user.platformAdmin === true}
                  archiveOwner={isArchiveOwner(user)}
                  backupAccess={!previewActive && canManageTreeBackups(user)}
                  publicationOwnership={publicationOwnership}
                  onClose={() => navigate("tree")}
                  onChanged={archive.reload}
                  save={save}
                  canEdit={canEdit && desktop}
                />
              ) : (
                <div className="archive-status">
                  <h1>Управление архивом</h1>
                  <p>Панель доступна администратору.</p>
                  {!user && <LoginButtons />}
                </div>
              )
            ) : (
              <main
                className={`archive-workspace ${view === "tree" ? "is-tree" : ""}`}
              >
                {readTree && (
                  <div
                    className={`tree-view ${view === "tree" ? "" : "is-hidden"}`}
                    inert={view !== "tree"}
                    aria-hidden={view !== "tree"}
                  >
                    <TreeCanvas
                      ref={treeCanvas}
                      restricted={Boolean(participantPreview)}
                      onPreferences={() => setTreePreferencesOpen(true)}
                      onExport={participantPreview ? undefined : () => setTreeExportOpen(true)}
                      onImport={canEdit && isArchiveOwner(user) ? () => setTreeImportOpen(true) : undefined}
                      onRename={canEdit && isArchiveOwner(user) ? () => setSettings(true) : undefined}
                      onAddSelf={canEdit && user && isArchiveOwner(user) && !user.personId ? newSelf : undefined}
                      skipInitialGrowth={initialPersonLink}
                      onGrowthChange={setTreeGrowing}
                      comparisonAction={
                        <div className="workspace-actions">
                          <button
                            className={compare ? "active" : ""}
                            title="Родство"
                            aria-pressed={compare}
                            onClick={() => {
                              if (!setPersonDraft(null)) return;
                              if (!closeConnection()) return;
                              clearPersonUrl();
                              dispatch({ type: "compare" });
                            }}
                          >
                            <ArrowDownUp size={17} />
                            Родство
                          </button>
                        </div>
                      }
                      onShare={
                        isArchiveOwner(user) && canEdit && desktop &&
                        !archiveContextAt(window.location.pathname)
                          ? (anchorId, ids) => {
                              const anchor = map.get(anchorId);
                              if (anchor)
                                setShareDraft({
                                  anchor,
                                  people: people.filter((p) =>
                                    ids.includes(p.id),
                                  ),
                                  revision: archive.getRevision(),
                                });
                            }
                          : undefined
                      }
                      onPublishPerson={
                        isArchiveOwner(user) && canEdit && publicationOwnership === "owner"
                          ? openPersonPublication
                          : undefined
                      }
                      publicationUpdate={publicationUpdate}
                      onAddRelative={(id, type) => {
                        if (!closeConnection()) return;
                        relative(type, false, id);
                      }}
                      family={family}
                      user={user}
                      canEdit={canEdit}
                      allowDragConnect={desktop}
                      busy={busy}
                      reverse={archive.reverseTimeline}
                      colorScheme={archive.treePreferences.colorScheme}
                      generationLimits={archive.treePreferences.generationLimits}
                      onGenerationAnchor={async (id) => {
                        await archive.saveTreePreferences(
                          withGenerationAnchor(archive.treePreferences, id),
                        );
                      }}
                      onResetGenerations={async () => {
                        await archive.saveTreePreferences({
                          ...archive.treePreferences, generationLimits: null,
                        });
                      }}
                      selected={selected}
                      selectedEdge={connectionDraft?.original?.key}
                      onChoose={choosePerson}
                        onModeChange={(mode) =>
                          setTimelineDetails(mode === "timeline")
                        }
                        onSelectOnly={selectPersonOnly}
                      onEdge={selectEdge}
                      onConnect={openConnection}
                      onClear={clear}
                      onAdd={newPerson}
                      onLink={startLink}
                      focus={focus}
                      assistantFilter={assistantFilter}
                      onClearAssistantFilter={() => setAssistantFilter(null)}
                      zoomRequest={assistantZoom}
                      preview={preview}
                      query={query}
                      highlighted={highlighted}
                      spotlight={spotlight}
                      onIntroComplete={() =>
                        setAssistantNudgeToken((value) => value + 1)
                      }
                    />
                    {canEdit && linkFrom !== null && (
                      <div className="link-instruction" role="status">
                        <Link2 size={18} />
                        {linkFrom
                          ? "Выберите второго человека"
                          : "Выберите первого человека"}
                        <button
                          onClick={() =>
                            openConnection({
                              from: linkFrom || "",
                              to: "",
                              type: "parent",
                            })
                          }
                        >
                          Выбрать из списка
                        </button>
                        <button
                          aria-label="Отменить связывание"
                          onClick={() => dispatch({ type: "finishLink" })}
                        >
                          <X size={17} />
                        </button>
                      </div>
                    )}
                    {personDraft ? (
                      <InspectorDock
                        key={personDraft.key}
                        onClose={closeEditor}
                        editing
                        label={personDraft.person ? "Редактировать человека" : "Новый человек"}
                        suspended={assistantOpen}
                      >
                        {personEditor}
                      </InspectorDock>
                    ) : connectionDraft ? (
                      <InspectorDock
                        key={connectionDraft.original?.key || "new-connection"}
                        onClose={closeConnection}
                        editing={canEdit}
                        label={connectionDraft.original ? "Редактировать связь" : "Новая связь"}
                        suspended={assistantOpen}
                      >
                        <ConnectionInspector
                          family={family}
                          user={user}
                          draft={connectionDraft}
                          canEdit={canEdit}
                          onChange={updateConnection}
                          save={save}
                          busy={busy}
                          onClose={closeConnection}
                          onSaved={finishConnection}
                          dirty={connectionDirty}
                        />
                      </InspectorDock>
                    ) : !treeGrowing &&
                      !selectionOnly &&
                      (compare || chosen.length > 0) ? (
                      <InspectorDock
                        key={
                          compare
                            ? `comparison:${chosen.length}`
                            : chosen[0]?.id
                        }
                        initialExpanded={!compare || chosen.length === 2}
                        allowExpand={!compare}
                        onClose={clear}
                        suspended={assistantOpen}
                      >
                        {compare ? (
                          <ComparisonPanel
                            selected={chosen}
                            relation={relation}
                            people={people}
                            links={family.links}
                            onRemove={(id) => choose(id, true)}
                            onReveal={() => reveal(relation?.path || selected)}
                          />
                        ) : (
                          chosen[0] && (
                            <PersonInspector
                              key={chosen[0].id}
                              person={chosen[0]}
                              family={family}
                              user={user}
                              canEdit={canEdit}
                              detailsLoading={!hasPersonDetails(chosen[0].id)}
                              loadPersonDetails={loadPersonDetails}
                              hasPersonDetails={hasPersonDetails}
                              onRetryDetails={() => {
                                void archive.loadDetails({ people: [chosen[0].id] }).catch((reason) =>
                                  setNotice(reason instanceof Error ? reason.message : "Не удалось загрузить карточку"));
                              }}
                              readOnlyPreview={Boolean(participantPreview)}
                              readPhotos={readPhotos}
                              save={save}
                              uploadPortrait={archive.uploadPortrait}
                              busy={busy}
                              onConnection={openConnection}
                              onSelect={showPerson}
                              onUrlPerson={(id) => {
                                const target: ArchiveTarget = {
                                  kind: "person",
                                  id,
                                };
                                lastUrlTarget.current = targetKey(target);
                                setView("tree", target);
                              }}
                              matchPath={user?.approved === true && publicationOwnership === "owner" &&
                                archiveContextAt(window.location.pathname)
                                ? adminMatchSourcePath(archiveContextAt(window.location.pathname)!.id, chosen[0].id)
                                : undefined}
                              onCompare={() => {
                                clearPersonUrl();
                                dispatch({ type: "compare" });
                              }}
                              onEdit={() =>
                                setPersonDraft({
                                  person: chosen[0],
                                  key: crypto.randomUUID(),
                                })
                              }
                              onNewRelative={(type) => relative(type, false)}
                              onExistingRelative={(type) =>
                                relative(type, true)
                              }
                              onAlbum={(id) => {
                                selectGalleryAlbum(id, null);
                              }}
                            />
                          )
                        )}
                      </InspectorDock>
                    ) : null}
                  </div>
                )}
                <ArchiveSection
                  view={view}
                  family={family}
                  people={people}
                  query={query}
                  user={user}
                  canEdit={canEdit && desktop}
                  mayEdit={!participantPreview && allowedEdit}
                  busy={busy}
                  loadingDetails={archive.loadingDetails ||
                    (needsPeopleDetails && !hasCollectionDetails("people")) ||
                    (needsPhotoDetails && !hasCollectionDetails("photos"))}
                  detailsError={archive.collectionError}
                  onRetryDetails={retryViewDetails}
                  save={save}
                  onPerson={showPerson}
                  onQuality={() => navigate("quality")}
                  onReveal={(ids, groupId) => {
                    lastUrlTarget.current = "";
                    setView("tree", undefined, true);
                    revealFamily(ids, groupId);
                  }}
                  onPhoto={openPhotoUrl}
                  onAddPhoto={() => photoWorkspace.openUpload()}
                  onDropPhoto={(file) => photoWorkspace.openUpload(file)}
                  documentPersonFilter={documentPersonFilter}
                  documentId={documentId}
                  documentPage={documentRoute?.pageNumber}
                  onSelectDocument={selectDocument}
                  personFilter={
                    view === "gallery"
                      ? new URL(
                          currentPath,
                          window.location.origin,
                        ).searchParams.get("personId")
                      : null
                  }
                  yearFilter={
                    view === "gallery"
                      ? new URL(
                          currentPath,
                          window.location.origin,
                        ).searchParams.get("year")
                      : null
                  }
                  onSelectPhotoAlbum={selectGalleryAlbum}
                />
              </main>
            )}
          </>
        ) : archive.needsLogin ? (
          <main className="archive-status">
            <h1>Семейный архив</h1>
            <p>{archive.error}</p>
            {participantPreview ? null : user || accountSession?.account ? (
              <button
                className="primary-action"
                onClick={() => navigate("account")}
              >
                Личный кабинет
              </button>
            ) : (
              <LoginButtons />
            )}
          </main>
        ) : archive.error ? (
          <main className="archive-status" role="alert">
            <h1>Не удалось открыть архив</h1>
            <p>{archive.error}</p>
            <button onClick={archive.reload}>Повторить загрузку</button>
          </main>
        ) : (
          <ArchiveLoading canvas={view === "tree"} />
        )}
      </div>
      {(archive.committedUploadNotice || notice) && (
        <div className="archive-toast" role="status">
          {archive.committedUploadNotice || notice}
          <button
            onClick={() => {
              archive.dismissCommittedUploadNotice();
              setNotice("");
            }}
            aria-label="Закрыть уведомление"
          >
            <X size={17} />
          </button>
        </div>
      )}
      {archive.loadingDetails && (
        <div className="archive-loading-details" role="status">
          Подгружаем сведения и фотографии…
        </div>
      )}
      {view === "tree" && timelineDetails && archive.collectionError && (
        <div className="archive-loading-details" role="alert">
          {archive.collectionError}{" "}
          <button type="button" onClick={retryViewDetails}>Повторить загрузку</button>
        </div>
      )}
      {entryPending && !participantPreview &&
        !archive.error &&
        !archive.needsLogin &&
        view !== "account" && view !== "admin" && view !== "manage" &&
        (!family || user) && (
          <EntrySequence
            onFinish={finishEntry}
            ready={!!family && !!user && !archive.loadingDetails}
          />
        )}
      {family && (
        <PhotoWorkspaceOverlays
          family={family}
          user={user}
          workspace={linkedPhotoWorkspace}
            loadPersonDetails={loadPersonDetails}
            hasPersonDetails={hasPersonDetails}
            onDirtyChange={(dirty) => {
            navigationDirty.current = dirty;
          }}
          canEdit={canEdit && desktop}
          busy={busy}
          save={save}
          upload={upload}
          onPerson={(id) => {
            closePhoto();
            showPerson(id);
          }}
        />
      )}
      {family && readTree && user && !participantPreview && view !== "admin" && view !== "manage" && view !== "account" && (
        <ResearchAssistant
          view={view}
          onOpenChange={setAssistantOpen}
          personIds={selected.slice(0, 2)}
          openPersonId={
            view === "tree" && !compare && !selectionOnly && !personDraft
              ? chosen[0]?.id
              : undefined
          }
          openPhotoId={photoWorkspace.photo?.id}
          currentPersonName={
            user.personId ? map.get(user.personId)?.name : undefined
          }
          nudgeToken={assistantNudgeToken}
          canEdit={allowedEdit}
          onChanged={(personId) => {
            if (personId) setPendingResearchPersonId(personId);
            archive.reload();
          }}
          onPerson={showPerson}
          onPhoto={openPhotoUrl}
          onReveal={(ids) => {
            const target: ArchiveTarget | undefined =
              ids.length === 1 ? { kind: "person", id: ids[0] } : undefined;
            lastUrlTarget.current = targetKey(target || null);
            setView("tree", target);
            reveal(ids);
          }}
          onFilter={(ids, label) => {
            setView("tree");
            setAssistantFilter({ ids, label, token: Date.now() });
          }}
          onHideReview={() => {
            setView("tree");
            setAssistantFilter({
              excludeNeedsReview: true,
              label: "Без карточек на проверке",
              token: Date.now(),
            });
          }}
          onZoom={(direction) =>
            setAssistantZoom((previous) => ({
              token: previous.token + 1,
              direction,
            }))
          }
          onExportTreePdf={async (scope) => {
            if (!treeCanvas.current)
              throw new Error("Откройте древо, чтобы сохранить его в PDF.");
            await treeCanvas.current.exportPdf(undefined, scope);
          }}
        />
      )}
      {restoredSessionState !== "ready" && (
        <dialog ref={restoredSessionDialog} className="restored-session-gate" aria-label="Проверка доступа"
          onCancel={(event) => event.preventDefault()}>
          <MemberPreviewBanner modal />
          {restoredSessionState === "checking" ? (
            <p>Проверяем доступ к архиву…</p>
          ) : (
            <>
              <p>Не удалось проверить сеанс. Сведения скрыты до повторной проверки.</p>
              <button type="button" onClick={validateRestoredSession}>Повторить проверку</button>
            </>
          )}
        </dialog>
      )}
      {settings && canEdit && family && isArchiveOwner(user) && (
        <ArchiveSettings
          family={family}
          save={save}
          busy={busy}
          onClose={() => setSettings(false)}
        />
      )}
      {treePreferencesOpen && family && readTree && (
        <TreePreferencesDialog
          preferences={archive.treePreferences}
          people={family.people}
          anchorId={selected[0] || user?.personId}
          onChange={archive.saveTreePreferences}
          onClose={() => setTreePreferencesOpen(false)}
          onAdmin={!participantPreview && isArchiveOwner(user) && user?.approved === true ? () => {
            setTreePreferencesOpen(false);
            navigate("manage");
          } : undefined}
        />
      )}
      {treeExportOpen && !participantPreview && family && readTree && (
        <TreeExportDialog
          onCheckExportWarnings={checkExportWarnings}
          onExportPdf={(signal) => treeCanvas.current!.exportPdf(signal, "current")}
          onExportText={async (signal) => {
            const ids = await treeCanvas.current!.visiblePersonIds(signal);
            const { downloadGenerationReport } = await import("./components/tree/download-generation-report");
            await downloadGenerationReport(ids, signal);
          }}
          onExportGenealogy={isArchiveOwner(user) ? async (format, signal, onError) => {
            const ids = await treeCanvas.current!.visiblePersonIds(signal);
            signal.throwIfAborted();
            downloadVisibleGenealogy(format, ids, onError);
          } : undefined}
          onClose={() => setTreeExportOpen(false)}
        />
      )}
      {treeImportOpen && family && isArchiveOwner(user) && (
        <TreeImportDialog
          canEdit={canEdit}
          onClose={() => setTreeImportOpen(false)}
          onImported={archive.reload}
        />
      )}
      {help && <AboutProject onClose={() => setHelp(false)} />}
      {archive.conflict && family && (
        <ConflictDialog conflict={archive.conflict} family={family} />
      )}
    </div>
    </MemberPreviewName.Provider>
  );
}
