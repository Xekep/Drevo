import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownUp, ImagePlus, Link2, Plus, Undo2, X } from "lucide-react";
import {
  analyzeKinship,
  owns,
  type Person,
  type GraphConnection,
  type ConnectionType,
} from "./domain";
import { useArchive } from "./hooks/useArchive";
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
import { FamiliesCatalog } from "./components/families-catalog";
import { Gallery, PhotoViewer } from "./components/gallery";
import { PhotoUpload } from "./components/photo-upload";
import { LoginDialog } from "./components/login-dialog";
import { AdminPanel } from "./components/admin-panel";
import { ArchiveSettings } from "./components/archive-settings";
import { EditorDialog } from "./components/editor-dialog";
import { ConflictDialog } from "./components/conflict-dialog";

type PersonDraft = {
  person?: Person;
  relative?: Person;
  type?: "child" | ConnectionType;
  key: string;
};
export default function App() {
  const archive = useArchive(),
    { family, user, busy, canEdit, readTree, readPhotos, save, upload } =
      archive;
  const selection = useWorkspaceSelection(),
    { selected, compare, linkFrom, focus, choose, reveal, dispatch } =
      selection;
  const [requestedView, setView] = useState<ArchiveView>(
    window.location.pathname.startsWith("/admin") ? "admin" : "tree",
  );
  const view =
    requestedView === "admin"
      ? "admin"
      : !readTree
        ? "gallery"
        : requestedView === "gallery" && !readPhotos
          ? "tree"
          : requestedView;
  const [query, setQuery] = useState(""),
    [login, setLogin] = useState(false),
    [help, setHelp] = useState(false),
    [settings, setSettings] = useState(false),
    [addMenu, setAddMenu] = useState(false),
    [notice, setNotice] = useState("");
  const [personDraft, setPersonDraft] = useState<PersonDraft | null>(null),
    [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(
      null,
    ),
    [preview, setPreview] = useState<ConnectionDraft | null>(null);
  const [photoUpload, setPhotoUpload] = useState(false),
    [photoId, setPhotoId] = useState<string | null>(null),
    [photoFilter, setPhotoFilter] = useState<string | null>(null),
    [resumePhoto, setResumePhoto] = useState<string | null>(null),
    [photoPersonId, setPhotoPersonId] = useState("");
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
  const navigate = useCallback((next: ArchiveView) => {
    setView(next);
    window.history.pushState(null, "", next === "admin" ? "/admin" : "/");
    setAddMenu(false);
    setPhotoFilter(null);
  }, []);
  useEffect(() => {
    const sync = () =>
      setView(window.location.pathname.startsWith("/admin") ? "admin" : "tree");
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const closeConnection = useCallback(() => {
    setConnectionDraft(null);
    setPreview(null);
  }, []);
  const openConnection = useCallback(
    (draft: ConnectionDraft) => {
      setPersonDraft(null);
      setConnectionDraft(draft);
      setPreview(draft);
      dispatch({ type: "finishLink" });
      setAddMenu(false);
    },
    [dispatch],
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
      if (linkFrom && linkFrom !== id) {
        openConnection({ from: linkFrom, to: id, type: "parent" });
        return;
      }
      closeConnection();
      choose(id, additive);
    },
    [linkFrom, openConnection, closeConnection, choose],
  );
  const showPerson = useCallback(
    (id: string) => {
      setView("tree");
      reveal([id]);
      closeConnection();
    },
    [reveal, closeConnection],
  );
  const clear = useCallback(() => {
    if (!personDraft && !connectionDraft) dispatch({ type: "clear" });
  }, [dispatch, personDraft, connectionDraft]);
  const newPerson = useCallback(() => {
    setPersonDraft({ key: crypto.randomUUID() });
    closeConnection();
    setAddMenu(false);
    setView("tree");
  }, [closeConnection]);
  const startLink = useCallback(() => {
    closeConnection();
    setPersonDraft(null);
    dispatch({ type: "link" });
    setAddMenu(false);
    setView("tree");
  }, [closeConnection, dispatch]);
  const updateConnection = useCallback((draft: ConnectionDraft) => {
    setConnectionDraft(draft);
    setPreview(draft);
  }, []);
  function closeEditor() {
    if (busy) return;
    setPersonDraft(null);
    if (resumePhoto) {
      setPhotoId(resumePhoto);
      setResumePhoto(null);
    }
  }
  function relative(type: "child" | ConnectionType, existing: boolean) {
    const p = chosen[0];
    if (!p) return;
    if (existing)
      openConnection({
        from: type === "child" ? p.id : "",
        to: type === "child" ? "" : p.id,
        type: type === "child" ? "parent" : type,
      });
    else setPersonDraft({ key: crypto.randomUUID(), relative: p, type });
  }
  const personEditor = family && personDraft && (
    <PersonEditor
      key={personDraft.key}
      inline={!resumePhoto}
      isAdmin={user?.role === "admin"}
      user={user}
      family={family}
      person={personDraft.person}
      relativeTo={personDraft.relative}
      initialRelationship={personDraft.type}
      upload={upload}
      save={save}
      busy={busy}
      onClose={closeEditor}
      onSaved={(id) => {
        if (resumePhoto) setPhotoPersonId(id);
        else showPerson(id);
      }}
    />
  );
  const photo = family?.photos?.find((p) => p.id === photoId);
  return (
    <div className="archive-app">
      <ArchiveNavigation
        view={view}
        onView={navigate}
        user={user}
        local={archive.local}
        readTree={readTree}
        readPhotos={readPhotos}
        onHelp={() => setHelp(true)}
      />
      <div className="archive-main">
        <ArchiveHeader
          title={family?.title || "История семьи"}
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
        {addMenu && (
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
                      {canEdit && (
                        <button
                          disabled={busy || !archive.canUndo}
                          onClick={() =>
                            void archive
                              .undo()
                              .then(() => {
                                setNotice("Последнее изменение отменено");
                                closeConnection();
                              })
                              .catch((e) => setNotice(e.message))
                          }
                        >
                          <Undo2 size={17} />
                          Отменить
                        </button>
                      )}
                    </div>
                    {linkFrom !== null && (
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
                    {personDraft && !resumePhoto ? (
                      <InspectorDock
                        key={personDraft.key}
                        onClose={closeEditor}
                        editing
                      >
                        {personEditor}
                      </InspectorDock>
                    ) : connectionDraft ? (
                      <InspectorDock
                        key={connectionDraft.original?.key || "new-connection"}
                        onClose={closeConnection}
                        editing
                      >
                        <ConnectionInspector
                          family={family}
                          user={user}
                          draft={connectionDraft}
                          onChange={updateConnection}
                          save={save}
                          busy={busy}
                          onClose={closeConnection}
                        />
                      </InspectorDock>
                    ) : compare || chosen.length > 0 ? (
                      <InspectorDock
                        key={compare ? "comparison" : chosen[0]?.id}
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
      {login && <LoginDialog onClose={() => setLogin(false)} />}
      {photoUpload && canEdit && (
        <PhotoUpload
          upload={upload}
          busy={busy}
          onClose={() => setPhotoUpload(false)}
          onUploaded={(id) => {
            setPhotoId(id);
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
          initialPersonId={photoPersonId}
          canEdit={owns(user, photo)}
          canDelete={user?.role === "admin"}
          busy={busy}
          save={save}
          onClose={() => {
            setPhotoId(null);
            setPhotoPersonId("");
          }}
          onPerson={(id) => {
            setPhotoId(null);
            setPhotoPersonId("");
            showPerson(id);
          }}
          onCreatePerson={() => {
            setResumePhoto(photo.id);
            setPhotoId(null);
            setPhotoPersonId("");
            setPersonDraft({ key: crypto.randomUUID() });
          }}
        />
      )}
      {resumePhoto && personEditor}
      {settings && family && user?.role === "admin" && (
        <ArchiveSettings
          family={family}
          save={save}
          busy={busy}
          onClose={() => setSettings(false)}
        />
      )}
      {help && (
        <EditorDialog
          title="Как работать с деревом"
          onClose={() => setHelp(false)}
        >
          <div className="archive-form">
            <p>
              «Древо» группирует людей по поколениям; «Хронология» показывает
              годы и исторические эпохи. Выбранный человек сохраняется при
              переключении.
            </p>
            <p>
              Тяните фон мышью или прокручивайте двумя пальцами. Масштаб —
              кнопками, щипком или Ctrl + колесо. Нажатие на карточку открывает
              сведения справа; Shift + нажатие выбирает второго человека для
              сравнения.
            </p>
            <p>
              Соедините точки на карточках или нажмите «Связь» и выберите двух
              людей. Предварительная линия сохраняется только после проверки и
              нажатия «Сохранить связь». Нажмите существующую линию, чтобы
              изменить её тип или участников.
            </p>
            <p>
              «Ветка» оставляет предков и потомков выбранного человека, а
              стрелка на карточке сворачивает потомков. «Отменить» возвращает
              последнее сохранённое изменение в этой вкладке. После загрузки
              фотографии начинается новая история отмены.
            </p>
            <p>
              На телефоне панель открывается снизу; кнопка над ней меняет
              высоту. Для связывания без перетаскивания используйте выбор из
              списка.
            </p>
          </div>
        </EditorDialog>
      )}
      {archive.conflict && family && (
        <ConflictDialog conflict={archive.conflict} family={family} />
      )}
    </div>
  );
}
