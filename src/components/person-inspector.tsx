import { useState } from "react";
import { Plus, Pencil, Images, Link2 } from "lucide-react";
import { PersonPanel } from "./person-panel";
import { PersonHints } from "./person-hints";
import type { Connection } from "../domain";
import {
  owns,
  fullName,
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
    [type, setType] = useState<"child" | "sibling" | ConnectionType>("child");
  const parents = family.people.filter((p) => person.parents.includes(p.id));
  const photos = (family.photos || []).filter((p) =>
    p.tags.some((t) => t.personId === person.id),
  );
  return (
    <>
      <div className="inspector-person-actions">
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
      {canEdit && adding && (
        <div className="relative-flow archive-form">
          <label>
            Кого добавить
            <select
              value={type}
              onChange={(e) =>
                setType(e.target.value as "child" | "sibling" | ConnectionType)
              }
            >
              <option value="child">Ребёнка</option>
              <option value="sibling">Брата / сестру</option>
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
          {type === "sibling" ? (
            <div className="sibling-guide">
              <p>
                Братья и сёстры определяются по родителям. Откройте общего
                родителя → «Родственник» → «Ребёнка» → добавьте нового человека
                или выберите существующего.
              </p>
              {parents.length > 0 ? (
                <div className="sibling-parent-links">
                  {parents.map((parent) => (
                    <button
                      key={parent.id}
                      onClick={() => {
                        setAdding(false);
                        onSelect(parent.id);
                      }}
                    >
                      {fullName(parent)}
                    </button>
                  ))}
                </div>
              ) : (
                <p>
                  У этого человека родители пока не указаны. Начните с
                  добавления родителя.
                </p>
              )}
              <dl>
                <dt>Родные</dt>
                <dd>
                  Одни и те же отец и мать. Укажите обоих родителей каждому
                  ребёнку.
                </dd>
                <dt>Единокровные</dt>
                <dd>Общий отец, разные матери.</dd>
                <dt>Единоутробные</dt>
                <dd>Общая мать, разные отцы.</dd>
                <dt>Сводные</dt>
                <dd>
                  Общих кровных родителей нет. Добавьте каждому своих родителей,
                  затем соедините браком родителя одного с родителем другого.
                </dd>
                <dt>Двоюродные</dt>
                <dd>
                  Их родители — брат и сестра, два брата или две сестры. Укажите
                  общих бабушку и дедушку через родителей.
                </dd>
              </dl>
              <p>
                Если второй родитель неизвестен, не создавайте вымышленного
                человека: родство покажем с учётом неполных сведений. «Названые
                брат / сестра» — отдельная дополнительная связь, это не сводное
                родство.
              </p>
              {owns(user, person) && (
                <button onClick={() => setType("parent")}>
                  Добавить родителя
                </button>
              )}
            </div>
          ) : (
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
          )}
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
