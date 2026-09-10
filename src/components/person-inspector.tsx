import { useState } from "react";
import { Plus, Pencil, Images, Link2, History, Expand } from "lucide-react";
import { PersonFullView } from "./person-full-view";
import { useDesktopEditing } from "../hooks/useDesktopEditing";
import { AuditLog } from "./audit-log";
import { EditorDialog } from "./editor-dialog";
import { PersonPanel } from "./person-panel";
import { PersonHints } from "./person-hints";
import { photoCaption, photoLabel } from "../domain/photo-metadata";
import { mediaPreview } from "../domain/media-preview";
import type { Connection } from "../domain";
import {
  owns,
  CONNECTION_NAMES,
  type ConnectionType,
  type Person,
  type Family,
  type ArchiveUser,
} from "../domain";
export function PersonInspector({
  person,
  family,
  user,
  canEdit,
  readPhotos,
  onSelect,
  onCompare,
  onEdit,
  onNewRelative,
  onExistingRelative,
  onAlbum,
  onPhoto,
  save,
  busy = false,
  onConnection,
}: {
  person: Person;
  family: Family;
  user: ArchiveUser | null;
  canEdit: boolean;
  readPhotos: boolean;
  onSelect: (id: string) => void;
  onCompare: () => void;
  onEdit: () => void;
  onNewRelative: (type: "child" | ConnectionType) => void;
  onExistingRelative: (type: "child" | ConnectionType) => void;
  onAlbum: () => void;
  onPhoto: (id: string) => void;
  save?: (family: Family) => Promise<Family>;
  busy?: boolean;
  onConnection?: (connection: Connection & { hint?: string }) => void;
}) {
  const [adding, setAdding] = useState(false),
    [type, setType] = useState<"child" | ConnectionType>("child");
  const [history, setHistory] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const desktop = useDesktopEditing();
  const photos = (family.photos || []).filter((p) =>
    p.tags.some((t) => t.personId === person.id),
  );
  return (
    <>
      <div className="inspector-person-actions">
        {desktop && (
          <button
            className="person-expand-button"
            title="Развернуть карточку"
            aria-label="Развернуть карточку на весь экран"
            onClick={() => setExpanded(true)}
          >
            <Expand size={16} />
          </button>
        )}
        {user?.role === "admin" && (
          <button
            className="person-history-button"
            title="История изменений"
            aria-label="История изменений человека"
            onClick={() => setHistory(true)}
          >
            <History size={15} />
          </button>
        )}
        {canEdit && owns(user, person) && (
          <button onClick={onEdit}>
            <Pencil size={16} />
            Изменить
          </button>
        )}
        {canEdit && (
          <button onClick={() => setAdding(!adding)} aria-expanded={adding}>
            <Plus size={16} />
            Родственник
          </button>
        )}
      </div>
      {history && user?.role === "admin" && (
        <EditorDialog
          title="История изменений человека"
          onClose={() => setHistory(false)}
          wide
        >
          <AuditLog personId={person.id} />
        </EditorDialog>
      )}
      {expanded && desktop && (
        <PersonFullView
          person={person}
          family={family}
          readPhotos={readPhotos}
          onClose={() => setExpanded(false)}
          onCompare={(id) => {
            onSelect(id);
            onCompare();
          }}
          onEdit={
            canEdit && owns(user, person)
              ? () => {
                  setExpanded(false);
                  onEdit();
                }
              : undefined
          }
          onPhoto={onPhoto}
        />
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
      <PersonPanel
        person={person}
        people={family.people}
        links={family.links}
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
      />
      {readPhotos && (
        <section className="person-photos">
          <button className="full-button" onClick={onAlbum}>
            <Images size={18} />
            Фотоальбом · {photos.length}
          </button>
          {photos.length > 0 && (
            <div className="person-photo-grid">
              {photos.slice(0, 6).map((p) => (
                <button key={p.id} onClick={() => onPhoto(p.id)}>
                  <img
                    src={mediaPreview(p.url)}
                    alt={photoLabel(p)}
                    loading="lazy"
                  />
                  {photoCaption(p) && <span>{photoCaption(p)}</span>}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
