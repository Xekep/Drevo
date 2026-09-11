import { useMemo, useRef, useState } from "react";
import { confirmDiscardChanges } from "../hooks/useUnsavedChanges";
import { Pencil } from "lucide-react";
import type { Family, Person } from "../domain/types";
import { fullName } from "../domain/dates";
import {
  familyNeighborhood,
  familyNeighbors,
} from "../domain/family-neighborhood";
import { EditorDialog } from "./editor-dialog";
import { PersonPanel } from "./person-panel";
import { TreeCanvas } from "./tree/tree-canvas";
import { PersonPhotoAlbum } from "./person-photo-album";
import { PersonEditor } from "./archive-editors";
import { owns, type ArchiveUser } from "../domain/access";
const noop = () => {};
export function PersonFullView({
  person,
  family,
  readPhotos,
  onClose,
  onCompare,
  user,
  canEdit,
  save,
  uploadPortrait,
  busy = false,
  onAlbum,
}: {
  person: Person;
  family: Family;
  readPhotos: boolean;
  onClose: () => void;
  onCompare: (id: string) => void;
  user: ArchiveUser | null;
  canEdit: boolean;
  save?: (family: Family) => Promise<Family>;
  uploadPortrait?: (file: File) => Promise<string>;
  busy?: boolean;
  onAlbum: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState(person.id);
  const [editing, setEditing] = useState(false);
  const dirty = useRef(false);
  const active = family.people.find((p) => p.id === activeId) || person;
  const editable = canEdit && owns(user, active) && !!save && !!uploadPortrait;
  const neighborhood = useMemo(() => {
    const ids = familyNeighborhood(familyNeighbors(family), active.id).visible;
    return {
      ...family,
      photos: [],
      people: family.people
        .filter((p) => ids.has(p.id))
        .map((p) => ({
          ...p,
          parents: p.parents.filter((id) => ids.has(id)),
          spouses: p.spouses.filter((id) => ids.has(id)),
        })),
      links: family.links?.filter((l) => ids.has(l.from) && ids.has(l.to)),
    };
  }, [family, active.id]);
  const photos = readPhotos
    ? (family.photos || []).filter((p) =>
        p.tags.some((t) => t.personId === active.id),
      )
    : [];
  return (
    <EditorDialog
      title={fullName(active)}
      onClose={() => {
        if (!busy && confirmDiscardChanges(dirty.current)) onClose();
      }}
      className="person-full-dialog"
    >
      <div
        className={`person-full-layout ${editing && editable ? "is-editing" : ""}`}
      >
        <section className="person-full-info" aria-label="Сведения о человеке">
          {editing && editable ? (
            <PersonEditor
              key={active.id}
              inline
              family={family}
              person={active}
              user={user}
              isAdmin={user?.role === "admin"}
              save={save}
              uploadPortrait={uploadPortrait}
              busy={busy}
              onDirtyChange={(value) => {
                dirty.current = value;
              }}
              onClose={() => setEditing(false)}
              onSaved={(id) => {
                setActiveId(id);
                setEditing(false);
              }}
            />
          ) : (
            <>
              {editable && (
                <button
                  className="full-person-edit"
                  onClick={() => setEditing(true)}
                >
                  <Pencil size={15} />
                  Изменить
                </button>
              )}
              <PersonPanel
                key={active.id}
                person={active}
                people={family.people}
                links={family.links}
                onSelect={setActiveId}
                onCompare={() => {
                  onClose();
                  onCompare(active.id);
                }}
              />
              {readPhotos && (
                <section className="full-person-photos">
                  <PersonPhotoAlbum
                    photos={photos}
                    onOpen={() => {
                      onClose();
                      onAlbum(active.id);
                    }}
                  />
                </section>
              )}
            </>
          )}
        </section>
        <section
          className="person-full-family"
          aria-label="Древо ближайшей семьи"
          inert={editing && editable}
        >
          <TreeCanvas
            restricted
            family={neighborhood}
            user={null}
            canEdit={false}
            busy={false}
            reverse={false}
            selected={[active.id]}
            onChoose={editing && editable ? noop : setActiveId}
            onEdge={noop}
            onConnect={noop}
            onClear={noop}
            onAdd={noop}
            onAddRelative={noop}
            onLink={noop}
            focus={null}
            preview={null}
            query=""
            highlighted={[]}
          />
          <p className="full-family-caption">
            {editing && editable
              ? "Сохраните изменения, чтобы перейти к другому человеку"
              : "Ближайшая семья · нажмите на человека, чтобы прочитать его историю"}
          </p>
        </section>
      </div>
    </EditorDialog>
  );
}
