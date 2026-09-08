import { useEffect, useState, type FormEvent } from "react";
import { Camera, UserRound } from "lucide-react";
import {
  availableColumn,
  connectPeople,
  CONNECTION_NAMES,
  fullName,
  splitFullName,
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
  const [portraitFile, setPortraitFile] = useState<File | null>(null),
    [portraitPreview, setPortraitPreview] = useState(""),
    [relationship, setRelationship] = useState("child");
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
        photo: portrait,
        name: draft.name.trim(),
        surname: draft.surname.trim(),
        patronymic: draft.patronymic.trim(),
        column:
          person && person.birth === draft.birth
            ? draft.column
            : availableColumn(
                current.people.filter((x) => x.id !== draft.id),
                draft.birth,
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
            : connectPeople(
                next,
                p.id,
                relativeTo.id,
                relationship === "parent" ? "parent" : "spouse",
              );
      }
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
              onChange={(e) => setRelationship(e.target.value)}
            >
              <option value="child">Ребёнок</option>
              {owns(user, relativeTo) && (
                <>
                  <option value="parent">Родитель</option>
                  <option value="spouse">Супруг / супруга</option>
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
        <details className="form-details person-extra">
          <summary>Дополнительные сведения</summary>
          <div className="form-grid">
            <label>
              Дата рождения
              <input
                value={draft.birth}
                placeholder="Год или ГГГГ-ММ-ДД"
                onChange={(e) => field("birth", e.target.value)}
              />
            </label>
            <label>
              Пол
              <select
                value={draft.sex}
                onChange={(e) => field("sex", e.target.value)}
              >
                <option value="u">Не указан</option>
                <option value="m">Мужской</option>
                <option value="f">Женский</option>
              </select>
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
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={draft[key] || ""}
                    placeholder={
                      key === "death" ? "ГГГГ или ГГГГ-ММ-ДД" : undefined
                    }
                    onChange={(e) =>
                      field(
                        key,
                        e.target.value || (key === "death" ? undefined : ""),
                      )
                    }
                  />
                </label>
              ))}
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
export function ConnectionEditor({
  user,
  family,
  initial,
  save,
  onClose,
  busy,
}: {
  family: Family;
  user: ArchiveUser | null;
  initial: string[];
  save: Save;
  onClose: () => void;
  busy: boolean;
}) {
  const [from, setFrom] = useState(initial[0] || ""),
    [to, setTo] = useState(initial[1] || ""),
    [type, setType] = useState<ConnectionType>("parent"),
    [additional, setAdditional] = useState(false),
    [note, setNote] = useState(""),
    [error, setError] = useState("");
  const people = [...family.people].sort((a, b) =>
    fullName(a).localeCompare(fullName(b), "ru"),
  );
  return (
    <EditorDialog title="Связать людей" onClose={onClose}>
      <form
        className="archive-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await save(connectPeople(family, from, to, type, note));
            onClose();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <p>
          Первый человек является указанным родственником для второго. Остальные
          степени родства вычисляются автоматически.
        </p>
        <label>
          Первый человек
          <select
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            <option value="">Выберите человека</option>
            {people
              .filter((p) => type === "parent" || owns(user, p))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {fullName(p)}
                </option>
              ))}
          </select>
        </label>
        <label>
          Группа связей
          <select
            value={additional ? "additional" : "family"}
            onChange={(e) => {
              const extra = e.target.value === "additional";
              setAdditional(extra);
              setType(extra ? "godparent" : "parent");
              setFrom("");
              setTo("");
            }}
          >
            <option value="family">Семья</option>
            <option value="additional">Крёстные, опека и другие связи</option>
          </select>
        </label>
        <label>
          Кем приходится
          <select
            value={type}
            onChange={(e) => {
              const next = e.target.value as ConnectionType;
              setType(next);
              if (
                next !== "parent" &&
                !owns(user, people.find((p) => p.id === from) || {})
              )
                setFrom("");
            }}
          >
            {Object.entries(CONNECTION_NAMES)
              .filter(
                ([key]) =>
                  additional !==
                  ["parent", "spouse", "adoptive_parent"].includes(key),
              )
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        <p className="field-hint">
          Братья, сёстры, предки, потомки и родственники супругов определяются
          по древу. Укажите общих родителей или брак.
        </p>
        <label>
          Второй человек
          <select required value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Выберите человека</option>
            {people
              .filter((p) => p.id !== from && owns(user, p))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {fullName(p)}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            setFrom(to);
            setTo(from);
          }}
        >
          Поменять местами
        </button>
        {!["parent", "spouse"].includes(type) && (
          <label>
            Примечание
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button className="primary-action" disabled={busy}>
            Сохранить связь
          </button>
          <button type="button" onClick={onClose}>
            Отмена
          </button>
        </footer>
      </form>
    </EditorDialog>
  );
}
