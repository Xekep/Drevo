import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Plus, Pencil, Link2, History, Expand, Ellipsis } from "lucide-react";
import { useDesktopEditing } from "../hooks/useDesktopEditing";
import { EditorDialog } from "./editor-dialog";
import { InspectorActions } from "./inspector-dock";
import { PersonPanel } from "./person-panel";
import { PersonHints } from "./person-hints";
import { PersonPhotoAlbum } from "./person-photo-album";
import { CopyArchiveLink } from "./copy-archive-link";
import { BookmarkButton } from "./personal-bookmarks";
import { LazyChunkBoundary } from "./lazy-chunk-boundary";
import { loadLazyModule } from "./lazy-section-recovery";
import type { Connection } from "../domain";
import {
  isArchiveOwner,
  owns,
  CONNECTION_NAMES,
  type ConnectionType,
  type Person,
  type Family,
  type ArchiveUser,
} from "../domain";

const AuditLog = lazy(() =>
  loadLazyModule(
    () =>
      import("./audit-log").then((module) => ({ default: module.AuditLog })),
    "person-audit-log",
  ),
);

const PersonFullView = lazy(() =>
  loadLazyModule(
    () =>
      import("./person-full-view").then((module) => ({
        default: module.PersonFullView,
      })),
    "person-full-view",
  ),
);

export function PersonInspector({
  person,
  family,
  user,
  canEdit,
  detailsLoading = false,
  detailsError,
  onRetryDetails,
  loadPersonDetails,
  hasPersonDetails,
  personPhotoTotal,
  readOnlyPreview = false,
  readPhotos,
  onSelect,
  onUrlPerson,
  matchPath,
  onCompare,
  onEdit,
  onNewRelative,
  onExistingRelative,
  onAlbum,
  save,
  uploadPortrait,
  busy = false,
  onConnection,
  onArchiveChanged,
}: {
  person: Person;
  family: Family;
  user: ArchiveUser | null;
  canEdit: boolean;
  detailsLoading?: boolean;
  detailsError?: string;
  onRetryDetails?: () => void;
  loadPersonDetails?: (id: string) => Promise<void>;
  hasPersonDetails?: (id: string) => boolean;
  personPhotoTotal?: (id: string) => number | undefined;
  readOnlyPreview?: boolean;
  readPhotos: boolean;
  onSelect: (id: string) => void;
  onUrlPerson?: (id: string) => void;
  matchPath?: string;
  onCompare: () => void;
  onEdit: () => void;
  onNewRelative: (type: "child" | ConnectionType) => void;
  onExistingRelative: (type: "child" | ConnectionType) => void;
  onAlbum: (id: string) => void;
  save?: (family: Family) => Promise<Family>;
  uploadPortrait?: (file: File) => Promise<string>;
  busy?: boolean;
  onConnection?: (connection: Connection & { hint?: string }) => void;
  onArchiveChanged?: () => void;
}) {
  const [adding, setAdding] = useState(false),
    [type, setType] = useState<"child" | ConnectionType>("child");
  const [history, setHistory] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const actionMenu = useRef<HTMLDetailsElement>(null);
  const closeActions = () => {
    if (actionMenu.current) actionMenu.current.open = false;
  };
  useEffect(() => {
    if (actionMenu.current) actionMenu.current.open = false;
    const outside = (event: PointerEvent) => {
      if (!actionMenu.current?.contains(event.target as Node)) {
        if (actionMenu.current) actionMenu.current.open = false;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !actionMenu.current?.open) return;
      event.preventDefault();
      event.stopPropagation();
      actionMenu.current.open = false;
      actionMenu.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [person.id]);
  const desktop = useDesktopEditing();
  const photos = (family.photos || []).filter((p) =>
    p.tags.some((t) => t.personId === person.id),
  );
  return (
    <>
      <InspectorActions>
        <div className="inspector-person-actions">
          {canEdit && !detailsLoading && owns(user, person) && (
            <button
              onClick={onEdit}
              className="person-edit-button person-primary-action"
              aria-label="Изменить человека"
              title="Изменить человека"
            >
              <Pencil size={16} />
              <span>Изменить</span>
            </button>
          )}
          <BookmarkButton target={{ kind: "person", id: person.id }} />
          {canEdit && !detailsLoading && (
            <button
              className="person-relative-button person-primary-action"
              onClick={() => setAdding(!adding)}
              aria-expanded={adding}
              title="Добавить родственника"
              aria-label="Добавить родственника"
            >
              <Plus size={18} />
              <span>Родственник</span>
            </button>
          )}
          {(onUrlPerson || matchPath || (desktop && !detailsLoading) || isArchiveOwner(user)) && (
            <details ref={actionMenu} className="person-more-actions">
              <summary aria-label="Другие действия с человеком" title="Другие действия">
                <Ellipsis size={18} aria-hidden="true" />
              </summary>
              <div className="person-more-menu">
                {onUrlPerson && <CopyArchiveLink target={{ kind: "person", id: person.id }} showLabel />}
                {matchPath && <a href={matchPath} onClick={closeActions}
                  aria-label="Найти совпадения в других древах" title="Найти совпадения в других древах">
                  <Link2 size={16} aria-hidden="true" /><span>Найти совпадения</span>
                </a>}
          {desktop && !detailsLoading && (
            <button
              className="person-expand-button"
              title="Развернуть карточку"
              aria-label="Развернуть карточку на весь экран"
              onClick={() => { closeActions(); setExpanded(true); }}
            >
              <Expand size={16} />
              <span>Развернуть карточку</span>
            </button>
          )}
          {isArchiveOwner(user) && (
            <button
              className="person-history-button"
              title="История изменений"
              aria-label="История изменений человека"
              onClick={() => { closeActions(); setHistory(true); }}
            >
              <History size={15} />
              <span>История изменений</span>
            </button>
          )}
              </div>
            </details>
          )}
        </div>
      </InspectorActions>
      {history && isArchiveOwner(user) && (
        <EditorDialog
          title="История изменений человека"
          onClose={() => setHistory(false)}
          wide
        >
          <LazyChunkBoundary message="Журнал изменений не загрузился. Обновите страницу и повторите открытие.">
            <Suspense
              fallback={
                <div className="archive-status" role="status">
                  Открываем журнал…
                </div>
              }
            >
              <AuditLog personId={person.id} onChanged={onArchiveChanged} />
            </Suspense>
          </LazyChunkBoundary>
        </EditorDialog>
      )}
      {expanded && desktop && (
        <LazyChunkBoundary message="Полная карточка не загрузилась. Обновите страницу и повторите открытие.">
          <Suspense
            fallback={
              <div className="archive-status" role="status">
                Открываем полную карточку…
              </div>
            }
          >
            <PersonFullView
              person={person}
              loadPersonDetails={loadPersonDetails}
              hasPersonDetails={hasPersonDetails}
              personPhotoTotal={personPhotoTotal}
              family={family}
              readPhotos={readPhotos}
              onClose={(id) => {
                setExpanded(false);
                if (id !== person.id) onSelect(id);
              }}
              onUrlPerson={onUrlPerson}
              onCompare={(id) => {
                onSelect(id);
                onCompare();
              }}
              user={user}
              canEdit={canEdit}
              save={save}
              uploadPortrait={uploadPortrait}
              busy={busy}
              onAlbum={onAlbum}
            />
          </Suspense>
        </LazyChunkBoundary>
      )}
      {canEdit && adding && (
        <div className="relative-flow archive-form">
          <label>
            Кого добавить
            <select
              value={type}
              onChange={(e) =>
                setType(e.target.value as "child" | ConnectionType)
              }
            >
              <option value="child">Ребёнка</option>
              {owns(user, person) && (
                <>
                  <option value="parent">Родителя</option>
                  <option value="spouse">Супруга / супругу</option>
                  <option value="godparent">Крёстный / крёстная</option>
                  <optgroup label="Дополнительная связь">
                    {Object.entries(CONNECTION_NAMES)
                      .filter(
                        ([key]) =>
                          !["parent", "spouse", "godparent"].includes(key),
                      )
                      .map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                  </optgroup>
                </>
              )}
            </select>
          </label>
          <p className="field-hint">
            Братья и сёстры определятся автоматически, когда вы укажете общих
            родителей. Для сводных укажите их родителей и брак между ними.
          </p>
          <div className="relative-choice">
            <button onClick={() => onNewRelative(type)}>
              <Plus size={16} />
              Новый человек
            </button>
            <button onClick={() => onExistingRelative(type)}>
              <Link2 size={16} />
              Уже в древе
            </button>
          </div>
        </div>
      )}
      {detailsLoading ? (
        <div
          className="archive-status"
          role={detailsError ? "alert" : "status"}
          aria-label="Загрузка сведений человека"
        >
          {detailsError ? <p>{detailsError}</p> : <span className="archive-loader-ring" aria-hidden="true" />}
          {detailsError && onRetryDetails && <button type="button" onClick={onRetryDetails}>
            Повторить загрузку
          </button>}
        </div>
      ) : <PersonPanel
        idPrefix="person-inspector"
        person={person}
        isCurrentUser={user?.personId === person.id}
        canDiscuss={user?.approved === true}
        readOnlyDiscussion={readOnlyPreview}
        canLoadDocuments={user?.approved === true}
        people={family.people}
        links={family.links}
        unions={family.unions}
        onSelect={onSelect}
        onCompare={onCompare}
        suggestions={
          canEdit &&
          adding &&
          save &&
          onConnection && (
            <PersonHints
              person={person}
              family={family}
              user={user}
              busy={busy}
              save={save}
              onConnection={onConnection}
            />
          )
        }
      />}
      {readPhotos && !detailsLoading && (
        <section className="person-photos">
          <PersonPhotoAlbum photos={photos} total={personPhotoTotal?.(person.id)} onOpen={() => onAlbum(person.id)} />
        </section>
      )}
    </>
  );
}
