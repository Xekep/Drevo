import { useEffect, useState, type FormEvent } from "react";
import { Camera, UserRound } from "lucide-react";
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
  birthSurnameHints,
  removePerson,
  removeConnection,
  type Connection,
  type ConnectionType,
  type Family,
  type Person,
  type ArchiveUser,
  type PhotoMetadata,
  owns,
} from "../domain";
import { EditorDialog } from "./editor-dialog";
import { PlaceField } from "./place-field";
type Save = (data: Family) => Promise<Family>;
export function PersonEditor({
  isAdmin,
  user,
  relativeTo,
  upload,
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
  upload: (file: File, metadata?: PhotoMetadata) => Promise<Family>;
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
      let current = family,
        portrait = draft.photo;
      if (portraitFile) {
        current = await upload(portraitFile, {
          title: `Портрет: ${draft.name} ${draft.surname}`,
        });
        portrait = current.photos![current.photos!.length - 1].url;
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
          <span className="portrait-preview">
            {portraitPreview || draft.photo ? (
              <img
                src={portraitPreview || draft.photo}
                alt="Портрет человека"
              />
            ) : (
              <UserRound size={34} strokeWidth={1.2} />
            )}
          </span>
          <div>
            <label className="upload-button">
              <Camera size={16} />
              {draft.photo || portraitFile
                ? "Изменить портрет"
                : "Добавить портрет"}
              <input
                type="file"
                disabled={busy}
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 20 * 1024 * 1024) {
                    setError("Размер портрета — до 20 МБ");
                    return;
                  }
                  setPortraitFile(file);
                  setPortraitPreview(URL.createObjectURL(file));
                  setError("");
                }}
              />
            </label>
            <small>Необязательно · снимок сохранится в галерее</small>
          </div>
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
        <details className="form-details person-extra">
          <summary>Дополнительные сведения</summary>
          <div className="form-grid">
            <label>
              Дата рождения
              <input
                value={birthText}
                placeholder="1.5.1980, 05.1980 или 1980"
                onChange={(e) => setBirthText(e.target.value)}
                onBlur={() => {
                  try {
                    setBirthText(dateInputLabel(normalizeDateInput(birthText)));
                  } catch {
                    /* Ошибка будет показана при сохранении. */
                  }
                }}
              />
            </label>
          </div>
          <details className="form-details">
            <summary>Уточнить части ФИО</summary>
            <div className="form-grid">
              {(
                [
                  ["surname", "Фамилия"],
                  ["name", "Имя"],
                  ["patronymic", "Отчество"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={draft[key]}
                    onChange={(e) => field(key, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </details>
          <section className="person-history-fields">
            <div className="form-grid">
              {(
                [
                  ["maidenName", "Фамилия при рождении"],
                  ["birthPlace", "Место рождения"],
                  ["death", "Дата смерти"],
                  ["deathPlace", "Место смерти"],
                  ["occupation", "Занятие"],
                ] as const
              ).map(([key, label]) =>
                key === "birthPlace" || key === "deathPlace" ? (
                  <PlaceField
                    key={key}
                    label={label}
                    value={draft[key] || ""}
                    onChange={(value) => field(key, value)}
                    onLocation={(location) =>
                      setDraft((current) => ({
                        ...current,
                        [key === "birthPlace"
                          ? "birthLocation"
                          : "deathLocation"]: location,
                      }))
                    }
                  />
                ) : (
                  <label key={key}>
                    {label}
                    <input
                      value={key === "death" ? deathText : draft[key] || ""}
                      placeholder={
                        key === "death"
                          ? "1.5.1980, 05.1980 или 1980"
                          : key.endsWith("Place")
                            ? "Название в то время, например Свердловск-44"
                            : undefined
                      }
                      onChange={(e) =>
                        key === "death"
                          ? setDeathText(e.target.value)
                          : field(key, e.target.value)
                      }
                    />
                  </label>
                ),
              )}
            </div>
            <label>
              История человека
              <textarea
                rows={4}
                value={draft.biography || ""}
                onChange={(e) => field("biography", e.target.value)}
              />
            </label>
          </section>
          <details className="form-details">
            <summary>Выбрать портрет из галереи или по ссылке</summary>
            <label>
              Портрет из галереи
              <select
                value={
                  (family.photos || []).some((p) => p.url === draft.photo)
                    ? draft.photo
                    : ""
                }
                onChange={(e) => field("photo", e.target.value)}
              >
                <option value="">Без портрета / ссылка ниже</option>
                {family.photos?.map((p) => (
                  <option key={p.id} value={p.url}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Ссылка на портрет
              <input
                value={draft.photo || ""}
                onChange={(e) => field("photo", e.target.value)}
                placeholder="https://… или /media/…"
              />
            </label>
          </details>
          <details className="form-details">
            <summary>Источники и дополнительные настройки</summary>
            <label className="check-field">
              <input
                type="checkbox"
                checked={!!draft.parentageComplete}
                onChange={(e) => field("parentageComplete", e.target.checked)}
              />{" "}
              Все кровные родители известны и указаны
            </label>
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
            {person && (
              <section>
                <h3>Прямые связи</h3>
                {connections.map((edge, i) => (
                  <div className="connection-row" key={i}>
                    <span>
                      {fullName(family.people.find((p) => p.id === edge.from)!)}{" "}
                      → {CONNECTION_NAMES[edge.type]} →{" "}
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
    </EditorDialog>
  );
}
