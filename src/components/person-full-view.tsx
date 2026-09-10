import { useMemo, useState } from "react";
import { Images, Pencil } from "lucide-react";
import type { Family, Person } from "../domain/types";
import { fullName } from "../domain/dates";
import {
  familyNeighborhood,
  familyNeighbors,
} from "../domain/family-neighborhood";
import { EditorDialog } from "./editor-dialog";
import { PersonPanel } from "./person-panel";
import { TreeCanvas } from "./tree/tree-canvas";
import { mediaPreview } from "../domain/media-preview";
const noop = () => {};
export function PersonFullView({
  person,
  family,
  readPhotos,
  onClose,
  onCompare,
  onEdit,
  onPhoto,
}: {
  person: Person;
  family: Family;
  readPhotos: boolean;
  onClose: () => void;
  onCompare: (id: string) => void;
  onEdit?: () => void;
  onPhoto: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState(person.id);
  const active = family.people.find((p) => p.id === activeId) || person;
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
      onClose={onClose}
      className="person-full-dialog"
    >
      <div className="person-full-layout">
        <section className="person-full-info" aria-label="Сведения о человеке">
          {active.id === person.id && onEdit && (
            <button className="full-person-edit" onClick={onEdit}>
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
          {!!photos.length && (
            <section className="full-person-photos">
              <h3>
                <Images size={16} />
                Фотографии · {photos.length}
              </h3>
              <div>
                {photos.map((photo) => (
                  <button
                    key={photo.id}
                    onClick={() => {
                      onClose();
                      onPhoto(photo.id);
                    }}
                    aria-label="Открыть фотографию"
                  >
                    <img src={mediaPreview(photo.url)} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </section>
        <section
          className="person-full-family"
          aria-label="Древо ближайшей семьи"
        >
          <TreeCanvas
            restricted
            family={neighborhood}
            user={null}
            canEdit={false}
            busy={false}
            reverse={false}
            selected={[active.id]}
            onChoose={setActiveId}
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
            Ближайшая семья · нажмите на человека, чтобы прочитать его историю
          </p>
        </section>
      </div>
    </EditorDialog>
  );
}
