import { useEffect, useState, type FormEvent } from "react";
import { Pencil, UserRound } from "lucide-react";
import {
  availableColumn,
  connectPeople,
  CONNECTION_NAMES,
  fullName,
  splitFullName,
  normalizeDateInput,
  dateInputLabel,
  guessSex,
  editorParentHints,
  siblingHints,
  birthSurnameHints,
  removePerson,
  removeConnection,
  type Connection,
  type ConnectionType,
  type Family,
  type Person,
  type ArchiveUser,
  owns,
} from "../domain";
import { EditorDialog } from "./editor-dialog";
import { PlaceField } from "./place-field";
import { AwardsEditor } from "./person-awards";
import { SiblingSuggestions } from "./sibling-suggestions";
import { PortraitCropper } from "./portrait-cropper";
import { photoLabel } from "../domain/photo-metadata";
import { mediaPreview } from "../domain/media-preview";
type Save = (data: Family) => Promise<Family>;
export function PersonEditor({
  isAdmin,
  user,
  relativeTo,
  uploadPortrait,
  family,
  person,
  save,
  onClose,
  onSaved,
  busy,
  inline = false,
  suspended = false,
  initialRelationship = "child",
}: {
  family: Family;
  person?: Person;
  isAdmin: boolean;
  user: ArchiveUser | null;
  relativeTo?: Person;
  uploadPortrait: (file: File) => Promise<string>;
  save: Save;
  onClose: () => void;
  onSaved: (id: string) => void;
  busy: boolean;
  inline?: boolean;
  suspended?: boolean;
  initialRelationship?: "child" | ConnectionType;
}) {
  const [draft, setDraft] = useState<Person>(() =>
    person
      ? structuredClone(person)
      : {
          id: crypto.randomUUID(),
          name: "",
          surname: "",
          patronymic: "",
          sex: "u",
          birth: "",
          birthPlace: "",
          parents: [],
          spouses: [],
          generation: 1,
          column: 0,
          sources: [],
        },
  );
  const [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const [nameText, setNameText] = useState(person ? fullName(person) : "");
  const [autoSex, setAutoSex] = useState(!person || person.sex === "u");
  const [accepted, setAccepted] = useState<string[]>([]);
  const [birthText, setBirthText] = useState(
    dateInputLabel(person?.birth || ""),
  );
  const [deathText, setDeathText] = useState(
    dateInputLabel(person?.death || ""),
  );
  const hintDate = (value: string) => {
    try {
      return normalizeDateInput(value);
    } catch {
      return "";
    }
  };
  const [portraitFile, setPortraitFile] = useState<File | null>(null),
    [portraitPreview, setPortraitPreview] = useState(""),
    [relationship, setRelationship] = useState<"child" | ConnectionType>(
      initialRelationship,
    );
  const [galleryOpen, setGalleryOpen] = useState(false),
    [cropSource, setCropSource] = useState("");
  const portraitPhotos = (family.photos || []).filter((photo) =>
    photo.tags.some((tag) => tag.personId === draft.id),
  );
  const hintDraft = {
    ...draft,
    birth: hintDate(birthText),
    death: hintDate(deathText) || undefined,
    sex: autoSex ? guessSex(draft) : draft.sex,
    parents:
      !person && relativeTo && relationship === "child"
        ? [...draft.parents, relativeTo.id]
        : draft.parents,
  };
  const suggestions = editorParentHints(
    hintDraft,
    family.people,
    accepted,
    family.links,
  ).filter(
    (hint) =>
      (hint.to === draft.id || owns(user, hint.person)) &&
      !(relativeTo && relationship === "parent" && hint.to === relativeTo.id),
  );
  const confirmed = suggestions.filter((hint) =>
    accepted.includes(`${hint.from}:${hint.to}`),
  );
  const siblings = siblingHints(
    {
      ...hintDraft,
      parents: [
        ...hintDraft.parents,
        ...confirmed.filter((h) => h.to === draft.id).map((h) => h.from),
      ],
    },
    family.people,
    family.links,
  );
  const surnames = birthSurnameHints(
    {
      ...hintDraft,
      parents: [
        ...hintDraft.parents,
        ...confirmed.filter((h) => h.to === draft.id).map((h) => h.from),
      ],
    },
    family.people,
  );
  useEffect(
    () => () => {
      if (portraitPreview) URL.revokeObjectURL(portraitPreview);
    },
    [portraitPreview],
  );
  function field(key: keyof Person, value: unknown) {
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (["name", "surname", "patronymic"].includes(key))
      setNameText(fullName(next));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (!draft.name.trim() || !draft.surname.trim())
        throw new Error("Укажите фамилию и имя. Отчество можно пропустить.");
      const birth = normalizeDateInput(birthText),
        death = normalizeDateInput(deathText) || undefined;
      const current = family;
      let portrait = draft.photo;
      if (portraitFile) {
        portrait = await uploadPortrait(portraitFile);
        field("photo", portrait);
        setPortraitFile(null);
        setPortraitPreview("");
      }
      const p = {
        ...draft,
        birth,
        death,
        sex: autoSex ? guessSex(draft) : draft.sex,
        photo: portrait,
        name: draft.name.trim(),
        surname: draft.surname.trim(),
        patronymic: draft.patronymic.trim(),
        column:
          person && person.birth === birth
            ? draft.column
            : availableColumn(
                current.people.filter((x) => x.id !== draft.id),
                birth,
              ),
      };
      let next = {
        ...current,
        people: person
          ? current.people.map((x) => (x.id === p.id ? p : x))
          : [...current.people, p],
      };
      if (!person && relativeTo) {
        next =
          relationship === "child"
            ? connectPeople(next, relativeTo.id, p.id, "parent")
            : connectPeople(next, p.id, relativeTo.id, relationship);
      }
      for (const hint of confirmed)
        next = connectPeople(next, hint.from, hint.to, "parent");
      await save(next);
      onSaved(p.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const connections: Connection[] = [
    ...family.people.flatMap((p) =>
      p.parents.map((id) => ({ from: id, to: p.id, type: "parent" as const })),
    ),
    ...family.people
      .flatMap((p) =>
        p.spouses.map((id) => ({
          from: p.id,
          to: id,
          type: "spouse" as const,
        })),
      )
      .filter(
        (e, i, a) =>
          a.findIndex(
            (x) =>
              [x.from, x.to].sort().join() === [e.from, e.to].sort().join(),
          ) === i,
      ),
    ...(family.links || []),
  ].filter((e) => e.from === draft.id || e.to === draft.id);
  return (
    <EditorDialog
      inline={inline}
      suspended={suspended}
      title={person ? "Редактировать человека" : "Новый человек"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} className="archive-form">
        <p className="flow-intro">
          {person
            ? "Дополните историю и сохраните изменения."
            : "Достаточно фамилии и имени. Остальные сведения можно добавить позже."}
        </p>
        <div className="portrait-picker">
          <button
            type="button"
            className="portrait-preview portrait-edit-button"
            onClick={() => setGalleryOpen(true)}
            disabled={busy}
            aria-label="Выбрать портрет из фотографий человека"
            aria-haspopup="dialog"
            title="Изменить портрет"
          >
            {portraitPreview || draft.photo ? (
              <img src={portraitPreview || mediaPreview(draft.photo)} alt="" />
            ) : (
              <UserRound size={34} strokeWidth={1.2} aria-hidden="true" />
            )}
            <span className="portrait-edit-overlay" aria-hidden="true">
              <Pencil size={22} strokeWidth={1.6} />
            </span>
          </button>
        </div>
        {relativeTo && !person && (
          <label>
            Кем новый человек приходится {fullName(relativeTo)}
            <select
              value={relationship}
              onChange={(e) =>
                setRelationship(e.target.value as "child" | ConnectionType)
              }
            >
              <option value="child">Ребёнок</option>
              {owns(user, relativeTo) && (
                <>
                  <option value="parent">Родитель</option>
                  <option value="spouse">Супруг / супруга</option>
                  <option value="godparent">Крёстный / крёстная</option>
                  <optgroup label="Другие связи">
                    {Object.entries(CONNECTION_NAMES)
                      .filter(
                        ([type]) =>
                          !["parent", "spouse", "godparent"].includes(type),
                      )
                      .map(([type, label]) => (
                        <option key={type} value={type}>
                          {label}
                        </option>
                      ))}
                  </optgroup>
                </>
              )}
            </select>
          </label>
        )}
        <label className="name-entry">
          ФИО
          <input
            required
            autoComplete="off"
            value={nameText}
            placeholder="Иванов Иван Иванович"
            aria-describedby="name-order-hint"
            onChange={(e) => {
              setNameText(e.target.value);
              setDraft((value) => ({
                ...value,
                ...splitFullName(e.target.value),
              }));
            }}
          />
          <small id="name-order-hint">
            Фамилия, имя, отчество. Отчество необязательно.
          </small>
        </label>
        <label className="name-sex-hint">
          Пол
          <select
            value={autoSex ? "auto" : draft.sex}
            onChange={(e) => {
              setAutoSex(e.target.value === "auto");
              if (e.target.value !== "auto") field("sex", e.target.value);
            }}
          >
            <option value="auto">
              {guessSex(draft) === "m"
                ? "Мужской · по ФИО"
                : guessSex(draft) === "f"
                  ? "Женский · по ФИО"
                  : "Определить по ФИО"}
            </option>
            <option value="m">Мужской</option>
            <option value="f">Женский</option>
          </select>
        </label>
        {suggestions.length > 0 && (
          <details className="name-suggestions" open>
            <summary>
              Возможно, уже есть родственники · {suggestions.length}
            </summary>
            <p>Отметьте верные связи — добавим их при сохранении.</p>
            <div className="name-suggestions-list">
              {suggestions.map((hint) => {
                const key = `${hint.from}:${hint.to}`;
                return (
                  <label
                    className="check-field"
                    key={key}
                    htmlFor={`hint-${key}`}
                    aria-label={`Подтвердить связь с ${fullName(hint.person)}`}
                  >
                    <input
                      id={`hint-${key}`}
                      type="checkbox"
                      checked={accepted.includes(key)}
                      onChange={(e) => {
                        setAccepted((values) =>
                          e.target.checked
                            ? [
                                ...values.filter(
                                  (value) =>
                                    !suggestions.some(
                                      (other) =>
                                        `${other.from}:${other.to}` === value &&
                                        other.to === hint.to &&
                                        other.parentSex === hint.parentSex,
                                    ),
                                ),
                                key,
                              ]
                            : values.filter((value) => value !== key),
                        );
                      }}
                    />
                    <span>
                      <b>
                        {hint.role === "father"
                          ? "Возможный отец"
                          : hint.role === "mother"
                            ? "Возможная мать"
                            : "Возможный ребёнок"}
                        : {fullName(hint.person)}
                      </b>
                      <small>{hint.reason}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </details>
        )}
        <SiblingSuggestions hints={siblings} />
        {surnames.map(({ surname, parent }) => (
          <div className="surname-suggestion" key={surname}>
            <p>
              Возможно, фамилия при рождении — <b>{surname}</b>. По фамилии
              отца: {fullName(parent)}.
            </p>
            <button type="button" onClick={() => field("maidenName", surname)}>
              Да, указать {surname}
            </button>
          </div>
        ))}
        {draft.maidenName && (
          <p className="birth-surname-value">
            Фамилия при рождении: <b>{draft.maidenName}</b>{" "}
            <button type="button" onClick={() => field("maidenName", "")}>
              Убрать
            </button>
          </p>
        )}
        <details className="form-details person-extra" open={!!person}>
          <summary>Рождение и смерть</summary>
          {(["birth", "death"] as const).map((kind) => (
            <section className="person-date-group" key={kind}>
              <h3>{kind === "birth" ? "Рождение" : "Смерть"}</h3>
              <div className="form-grid">
                <label>
                  Дата
                  <input
                    value={kind === "birth" ? birthText : deathText}
                    placeholder="1.5.1980, 05.1980 или 1980"
                    onChange={(e) =>
                      (kind === "birth" ? setBirthText : setDeathText)(
                        e.target.value,
                      )
                    }
                    onBlur={() => {
                      try {
                        (kind === "birth" ? setBirthText : setDeathText)(
                          dateInputLabel(
                            normalizeDateInput(
                              kind === "birth" ? birthText : deathText,
                            ),
                          ),
                        );
                      } catch {
                        /* Проверяется при сохранении. */
                      }
                    }}
                  />
                </label>
                <PlaceField
                  label="Место"
                  value={
                    draft[kind === "birth" ? "birthPlace" : "deathPlace"] || ""
                  }
                  onChange={(value) =>
                    field(kind === "birth" ? "birthPlace" : "deathPlace", value)
                  }
                  onLocation={(location) =>
                    setDraft((current) => ({
                      ...current,
                      [kind === "birth" ? "birthLocation" : "deathLocation"]:
                        location,
                    }))
                  }
                />
              </div>
            </section>
          ))}
        </details>
        <details className="form-details">
          <summary>ФИО и фамилия при рождении</summary>
          <div className="form-grid">
            {(
              [
                ["surname", "Фамилия"],
                ["name", "Имя"],
                ["patronymic", "Отчество"],
                ["maidenName", "Фамилия при рождении"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={draft[key] || ""}
                  onChange={(e) => field(key, e.target.value)}
                />
              </label>
            ))}
          </div>
        </details>
        <details className="form-details">
          <summary>Жизнь и занятия</summary>
          <label>
            Занятие
            <input
              value={draft.occupation || ""}
              onChange={(e) => field("occupation", e.target.value)}
            />
          </label>
          <label>
            История человека
            <textarea
              rows={4}
              value={draft.biography || ""}
              onChange={(e) => field("biography", e.target.value)}
            />
          </label>
        </details>
        <AwardsEditor
          awards={draft.awards || []}
          onChange={(awards) => field("awards", awards)}
        />
        <details className="form-details">
          <summary>Источники</summary>
          <section>
            <h3>Источники</h3>
            {draft.sources.map((s, i) => (
              <div className="source-editor" key={i}>
                {(
                  [
                    ["title", "Название"],
                    ["type", "Тип документа"],
                    ["reference", "Архивный шифр"],
                    ["url", "Ссылка"],
                    ["note", "Примечание"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      value={s[key] || ""}
                      onChange={(e) =>
                        field(
                          "sources",
                          draft.sources.map((x, j) =>
                            i === j ? { ...x, [key]: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    field(
                      "sources",
                      draft.sources.filter((_, j) => i !== j),
                    )
                  }
                >
                  Убрать источник
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                field("sources", [
                  ...draft.sources,
                  { title: "", type: "", reference: "" },
                ])
              }
            >
              + Источник
            </button>
          </section>
        </details>
        <details className="form-details">
          <summary>Семейные связи</summary>
          {draft.parents.length > 0 && (
            <>
              <p>
                {draft.parents
                  .map((id) => family.people.find((p) => p.id === id))
                  .filter((p) => !!p)
                  .map((p) => fullName(p))
                  .join(" · ")}
              </p>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={draft.parentageComplete ?? draft.parents.length >= 2}
                  onChange={(e) => field("parentageComplete", e.target.checked)}
                />
                Все кровные родители известны и указаны
              </label>
              <p className="field-hint">
                Если второй родитель неизвестен, оставьте отметку выключенной.
                Она помогает различать родных и неполнородных братьев и сестёр.
              </p>
            </>
          )}
          {person && (
            <section>
              <h3>Прямые связи</h3>
              {connections.map((edge, i) => (
                <div className="connection-row" key={i}>
                  <span>
                    {fullName(family.people.find((p) => p.id === edge.from)!)} →{" "}
                    {CONNECTION_NAMES[edge.type]} →{" "}
                    {fullName(family.people.find((p) => p.id === edge.to)!)}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        await save(removeConnection(family, edge));
                        onClose();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Убрать
                  </button>
                </div>
              ))}
            </section>
          )}
        </details>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <footer>
          <button type="submit" className="primary-action" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          {person && isAdmin && (
            <button
              type="button"
              className="danger-action"
              disabled={busy}
              onClick={async () => {
                if (!confirm) {
                  setConfirm(true);
                  return;
                }
                try {
                  await save(removePerson(family, person.id));
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {confirm ? "Подтвердить удаление человека" : "Удалить человека"}
            </button>
          )}
        </footer>
        {confirm && (
          <p>
            Карточка, связи и отметки этого человека будут удалены. Сами
            фотографии останутся.
          </p>
        )}
      </form>
      {galleryOpen && (
        <EditorDialog
          title="Выбрать портрет"
          onClose={() => setGalleryOpen(false)}
          wide
        >
          <div className="portrait-gallery">
            {portraitPhotos.map((photo) => (
              <button
                type="button"
                key={photo.id}
                onClick={() => {
                  setGalleryOpen(false);
                  setCropSource(photo.url);
                }}
              >
                <img
                  src={mediaPreview(photo.url)}
                  alt={photoLabel(photo)}
                  loading="lazy"
                />
                <span>{photoLabel(photo)}</span>
              </button>
            ))}
            {!portraitPhotos.length && (
              <p className="portrait-gallery-empty">
                {person
                  ? "Пока нет снимков с отметкой этого человека. Отметьте его на фото в галерее."
                  : "Сначала сохраните человека и отметьте его на фото."}
              </p>
            )}
          </div>
          {(draft.photo || portraitFile) && (
            <div className="portrait-gallery-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  field("photo", "");
                  setPortraitFile(null);
                  setPortraitPreview("");
                  setGalleryOpen(false);
                }}
              >
                Убрать портрет
              </button>
            </div>
          )}
        </EditorDialog>
      )}
      {cropSource && (
        <PortraitCropper
          key={cropSource}
          src={cropSource}
          onClose={() => setCropSource("")}
          onCrop={(file) => {
            setPortraitFile(file);
            setPortraitPreview(URL.createObjectURL(file));
            setCropSource("");
          }}
        />
      )}
    </EditorDialog>
  );
}
