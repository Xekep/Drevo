import { useState } from "react";
import { Plus, Pencil, Images, Link2 } from "lucide-react";
import { PersonPanel } from "./person-panel";
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
}) {
  const [adding, setAdding] = useState(false),
    [type, setType] = useState<"child" | ConnectionType>("child");
  const photos = (family.photos || []).filter((p) =>
    p.tags.some((t) => t.personId === person.id),
  );
  return (
    <>
      <div className="inspector-person-actions">
        {owns(user, person) && (
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
      {adding && (
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
                  <img src={p.url} alt={p.title} loading="lazy" />
                  <span>{p.title}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
