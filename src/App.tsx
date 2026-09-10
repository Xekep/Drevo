import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ArrowDownUp, ImagePlus, Link2, Plus, X } from "lucide-react";
import {
  analyzeKinship,
  suggestConnectionOrder,
  owns,
  type Person,
  type GraphConnection,
  type ConnectionType,
} from "./domain";
import { useArchive } from "./hooks/useArchive";
import { useArchiveView } from "./hooks/useArchiveView";
import { useWorkspaceSelection } from "./hooks/useWorkspaceSelection";
import {
  ArchiveNavigation,
  ArchiveHeader,
  type ArchiveView,
} from "./components/archive-navigation";
import {
  TreeCanvas,
  type ConnectionDraft,
} from "./components/tree/tree-canvas";
import { InspectorDock } from "./components/inspector-dock";
import { PersonInspector } from "./components/person-inspector";
import { ConnectionInspector } from "./components/connection-inspector";
import { ComparisonPanel } from "./components/comparison-panel";
import { PersonEditor } from "./components/archive-editors";
import { PeopleCatalog } from "./components/people-catalog";
const PlacesMap = lazy(() => import("./components/places-map"));
import { FamiliesCatalog } from "./components/families-catalog";
import { Gallery, PhotoViewer } from "./components/gallery";
import { PhotoUpload } from "./components/photo-upload";
import { LoginDialog } from "./components/login-dialog";
import { AdminPanel } from "./components/admin-panel";
import { ArchiveSettings } from "./components/archive-settings";
import { AboutProject } from "./components/about-project";
import { useDesktopEditing } from "./hooks/useDesktopEditing";
import { ConflictDialog } from "./components/conflict-dialog";
import { ShareDialog } from "./components/share-dialog";

type PersonDraft = {
  person?: Person;
  relative?: Person;
  type?: "child" | ConnectionType;
  key: string;
};
export default function App() {
  const archive = useArchive(),
    {
      family,
      user,
      busy,
      canEdit: allowedEdit,
      readTree,
      readPhotos,
      save: saveArchive,
      upload: uploadArchive,
    } = archive;
  const desktop = useDesktopEditing(),
    canEdit = allowedEdit && desktop;
  const save = useCallback<typeof archive.save>(
    (data) => {
      if (!canEdit)
        return Promise.reject(
          new Error("Редактирование доступно с компьютера."),
        );
      return saveArchive(data);
    },
    [canEdit, saveArchive],
  );
  const upload = useCallback<typeof archive.upload>(
    (...args) => {
      if (!canEdit)
        return Promise.reject(new Error("Загрузка доступна с компьютера."));
      return uploadArchive(...args);
    },
    [canEdit, uploadArchive],
  );
  const selection = useWorkspaceSelection(),
    { selected, compare, linkFrom, focus, choose, reveal, dispatch } =
      selection;
  const [requestedView, setView] = useArchiveView();
  const view =
    requestedView === "admin" && desktop
      ? "admin"
      : requestedView === "places" && (readTree || readPhotos)
        ? "places"
        : !readTree
          ? "gallery"
          : requestedView === "gallery" && !readPhotos
            ? "tree"
            : requestedView === "admin"
              ? "tree"
              : requestedView;
  const [query, setQuery] = useState(""),
    [login, setLogin] = useState(false),
    [help, setHelp] = useState(false),
    [settings, setSettings] = useState(false),
    [addMenu, setAddMenu] = useState(false),
    [notice, setNotice] = useState("");
  const [shareDraft, setShareDraft] = useState<{
    anchor: Person;
    people: Person[];
    revision: number;
  } | null>(null);
  const [personDraft, setPersonDraft] = useState<PersonDraft | null>(null),
    [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(
      null,
    ),
    [preview, setPreview] = useState<ConnectionDraft | null>(null);
  const [photoUpload, setPhotoUpload] = useState(false),
    [photoId, setPhotoId] = useState<string | null>(null),
    [editPhotoId, setEditPhotoId] = useState<string | null>(null),
    [photoFilter, setPhotoFilter] = useState<string | null>(null);
  const people = useMemo(() => family?.people || [], [family]);
  const map = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const chosen = useMemo(
    () => selected.flatMap((id) => (map.has(id) ? [map.get(id)!] : [])),
    [selected, map],
  );
  const relation = useMemo(
    () =>
      chosen.length === 2
        ? analyzeKinship(chosen[0], chosen[1], people, family?.links)
        : null,
    [chosen, people, family?.links],
  );
  const highlighted = useMemo(() => relation?.path || [], [relation]);
  const navigate = useCallback(
    (next: ArchiveView) => {
      setView(next);
      setAddMenu(false);
      setPhotoFilter(null);
    },
    [setView],
  );
  useEffect(() => {
    const sync = () => {
      setAddMenu(false);
      setPhotoFilter(null);
      setPhotoId(null);
      setEditPhotoId(null);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const closeConnection = useCallback(() => {
    setConnectionDraft(null);
    setPreview(null);
  }, []);
  const openConnection = useCallback(
    (draft: ConnectionDraft) => {
      if (!canEdit) return;
      if (!draft.original)
        draft = suggestConnectionOrder(draft, people, family?.links);
      setPersonDraft(null);
      setConnectionDraft(draft);
      setPreview(draft);
      dispatch({ type: "finishLink" });
      setAddMenu(false);
    },
    [dispatch, canEdit, people, family?.links],
  );
  const selectEdge = useCallback(
    (edge: GraphConnection) => {
      setPersonDraft(null);
      setConnectionDraft({ ...edge, original: edge });
      setPreview(null);
      dispatch({ type: "finishLink" });
    },
    [dispatch],
  );
  const choosePerson = useCallback(
    (id: string, additive = false) => {
      if (canEdit && linkFrom && linkFrom !== id) {
        openConnection({ from: linkFrom, to: id, type: "parent" });
        return;
      }
      closeConnection();
      choose(id, additive);
    },
    [canEdit, linkFrom, openConnection, closeConnection, choose],
  );
  const showPerson = useCallback(
    (id: string) => {
      setView("tree");
      reveal([id]);
      closeConnection();
    },
    [reveal, closeConnection, setView],
  );
  const clear = useCallback(() => {
    if (!personDraft && !connectionDraft) dispatch({ type: "clear" });
  }, [dispatch, personDraft, connectionDraft]);
  const newPerson = useCallback(() => {
    if (!canEdit) return;
    setPersonDraft({ key: crypto.randomUUID() });
    closeConnection();
    setAddMenu(false);
    setView("tree");
  }, [canEdit, closeConnection, setView]);
  const startLink = useCallback(() => {
    if (!canEdit) return;
    closeConnection();
    setPersonDraft(null);
    dispatch({ type: "link" });
    setAddMenu(false);
    setView("tree");
  }, [canEdit, closeConnection, dispatch, setView]);
  const updateConnection = useCallback((draft: ConnectionDraft) => {
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
        isAdmin={user?.role === "admin"}
        user={user}
        family={family}
        person={personDraft.person}
        relativeTo={personDraft.relative}
        initialRelationship={personDraft.type}
        uploadPortrait={archive.uploadPortrait}
        save={save}
        busy={busy}
        onClose={closeEditor}
        onSaved={showPerson}
      />
    </div>
  );
  const photo = family?.photos?.find((p) => p.id === photoId);
  return (
    <div className="archive-app">
      {shareDraft && (
        <ShareDialog {...shareDraft} onClose={() => setShareDraft(null)} />
      )}
      <div className="archive-main">
        <ArchiveHeader
          navigation={
            <ArchiveNavigation
              desktop={desktop}
              view={view}
              onView={navigate}
              user={user}
              local={archive.local}
              readTree={readTree}
              readPhotos={readPhotos}
              onHelp={() => setHelp(true)}
            />
          }
          people={people}
          query={query}
          onQuery={setQuery}
          onSelect={showPerson}
          onAdd={() => setAddMenu(!addMenu)}
          canEdit={canEdit}
          busy={busy}
          onLogin={() => setLogin(true)}
          user={user}
        />
        {addMenu && canEdit && (
          <div className="archive-add-menu">
            <button onClick={newPerson}>
              <Plus size={18} />
              Человека
            </button>
            <button
              onClick={() => {
                setPhotoUpload(true);
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
        {family ? (
          <>
            {view === "admin" ? (
              user?.role === "admin" ? (
                <AdminPanel
                  family={family}
                  onClose={() => navigate("tree")}
                  onChanged={archive.reload}
                  onSettings={() => setSettings(true)}
                />
              ) : (
                <div className="archive-status">
                  <h1>Управление архивом</h1>
                  <p>Панель доступна администратору.</p>
                  {!user && (
                    <button
                      className="primary-action"
                      onClick={() => setLogin(true)}
                    >
                      Войти
                    </button>
                  )}
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
                      onShare={
                        user?.role === "admin" && canEdit
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
                      onAddRelative={(id, type) => {
                        closeConnection();
                        relative(type, false, id);
                      }}
                      family={family}
                      user={user}
                      canEdit={canEdit}
                      busy={busy}
                      reverse={archive.reverseTimeline}
                      selected={selected}
                      selectedEdge={connectionDraft?.original?.key}
                      onChoose={choosePerson}
                      onEdge={selectEdge}
                      onConnect={openConnection}
                      onClear={clear}
                      onAdd={newPerson}
                      onLink={startLink}
                      focus={focus}
                      preview={preview}
                      query={query}
                      highlighted={highlighted}
                    />
                    <div className="workspace-actions">
                      <button
                        className={compare ? "active" : ""}
                        onClick={() => {
                          setPersonDraft(null);
                          closeConnection();
                          dispatch({ type: "compare" });
                        }}
                      >
                        <ArrowDownUp size={17} />
                        Родство
                      </button>
                    </div>
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
                      >
                        {!canEdit && (
                          <p className="desktop-edit-notice">
                            Черновик сохранён в этой вкладке. Продолжить
                            редактирование можно в окне компьютера.
                          </p>
                        )}
                        {personEditor}
                      </InspectorDock>
                    ) : connectionDraft ? (
                      <InspectorDock
                        key={connectionDraft.original?.key || "new-connection"}
                        onClose={closeConnection}
                        editing={canEdit}
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
                        />
                      </InspectorDock>
                    ) : compare || chosen.length > 0 ? (
                      <InspectorDock
                        key={
                          compare
                            ? `comparison:${chosen.length}`
                            : chosen[0]?.id
                        }
                        initialExpanded={!compare || chosen.length === 2}
                        onClose={() => dispatch({ type: "clear" })}
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
                              readPhotos={readPhotos}
                              save={save}
                              busy={busy}
                              onConnection={openConnection}
                              onSelect={showPerson}
                              onCompare={() => dispatch({ type: "compare" })}
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
                              onAlbum={() => {
                                setPhotoFilter(chosen[0].id);
                                setView("gallery");
                              }}
                              onPhoto={setPhotoId}
                            />
                          )
                        )}
                      </InspectorDock>
                    ) : null}
                  </div>
                )}
                {view === "list" && (
                  <PeopleCatalog
                    people={people}
                    query={query}
                    onSelect={showPerson}
                  />
                )}
                {view === "places" && (archive.readTree || readPhotos) && (
                  <Suspense
                    fallback={
                      <div className="archive-status">Открываем карту…</div>
                    }
                  >
                    <PlacesMap
                      family={family}
                      user={user}
                      canEdit={canEdit}
                      busy={busy}
                      save={save}
                      onPerson={showPerson}
                      onPhoto={setPhotoId}
                    />
                  </Suspense>
                )}
                {view === "families" && (
                  <FamiliesCatalog
                    people={people}
                    onPerson={showPerson}
                    onReveal={(ids) => {
                      setView("tree");
                      reveal(ids);
                    }}
                  />
                )}
                {view === "gallery" && (
                  <Gallery
                    family={family}
                    canEdit={canEdit}
                    onAdd={() => setPhotoUpload(true)}
                    onOpen={setPhotoId}
                    personFilter={photoFilter}
                    onClearFilter={() => setPhotoFilter(null)}
                  />
                )}
              </main>
            )}
          </>
        ) : (
          <main className="archive-status">
            <h1>
              {archive.needsLogin ? "Семейный архив" : "Открываем архив…"}
            </h1>
            <p>{archive.error || "Загружаем людей, связи и фотографии."}</p>
            {archive.needsLogin ? (
              <button className="primary-action" onClick={() => setLogin(true)}>
                Войти через Яндекс
              </button>
            ) : (
              archive.error && (
                <button onClick={archive.reload}>Повторить загрузку</button>
              )
            )}
          </main>
        )}
      </div>
      {notice && (
        <div className="archive-toast" role="status">
          {notice}
          <button
            onClick={() => setNotice("")}
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
      {login && <LoginDialog onClose={() => setLogin(false)} />}
      {photoUpload && canEdit && (
        <PhotoUpload
          upload={upload}
          busy={busy}
          onClose={() => setPhotoUpload(false)}
          onUploaded={(id) => {
            setPhotoId(id);
            setEditPhotoId(id);
            setView("gallery");
            setPhotoFilter(null);
          }}
        />
      )}
      {photo && family && (
        <PhotoViewer
          key={photo.id}
          photo={photo}
          family={family}
          initialEditing={editPhotoId === photo.id}
          canEdit={canEdit && owns(user, photo)}
          canDelete={canEdit && user?.role === "admin"}
          busy={busy}
          save={save}
          onClose={() => {
            setEditPhotoId(null);
            setPhotoId(null);
          }}
          onPerson={(id) => {
            setEditPhotoId(null);
            setPhotoId(null);
            showPerson(id);
          }}
        />
      )}
      {settings && canEdit && family && user?.role === "admin" && (
        <ArchiveSettings
          family={family}
          save={save}
          busy={busy}
          onClose={() => setSettings(false)}
        />
      )}
      {help && (
        <AboutProject
          people={readTree ? family?.people : undefined}
          onClose={() => setHelp(false)}
        />
      )}
      {archive.conflict && family && (
        <ConflictDialog conflict={archive.conflict} family={family} />
      )}
    </div>
  );
}
