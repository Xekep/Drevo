import { useState, type FormEvent } from "react";
import {
  availableColumn,
  connectPeople,
  CONNECTION_NAMES,
  fullName,
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
type Save = (data: Family) => Promise<Family>;
export function PersonEditor({
  isAdmin,
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
          sex: "m",
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
  function field(key: keyof Person, value: unknown) {
    setDraft((p) => ({ ...p, [key]: value }));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const p = {
        ...draft,
        column: person
          ? draft.column
          : availableColumn(family.people, draft.birth),
      };
      const next = {
        ...family,
        people: person
          ? family.people.map((x) => (x.id === p.id ? p : x))
          : [...family.people, p],
      };
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
      onClose={onClose}
    >
      <form onSubmit={submit} className="archive-form">
        <div className="form-grid">
          {(
            [
              ["surname", "Фамилия"],
              ["name", "Имя"],
              ["patronymic", "Отчество"],
              ["maidenName", "Девичья фамилия"],
              ["birth", "Рождение"],
              ["death", "Смерть"],
              ["birthPlace", "Место рождения"],
              ["deathPlace", "Место смерти"],
              ["occupation", "Занятие"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                value={draft[key] || ""}
                required={["name", "surname", "birth"].includes(key)}
                placeholder={
                  key === "birth" || key === "death"
                    ? "ГГГГ или ГГГГ-ММ-ДД"
                    : undefined
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
          <label>
            Пол
            <select
              value={draft.sex}
              onChange={(e) => field("sex", e.target.value)}
            >
              <option value="m">Мужской</option>
              <option value="f">Женский</option>
            </select>
          </label>
        </div>
        <label>
          История человека
          <textarea
            rows={4}
            value={draft.biography || ""}
            onChange={(e) => field("biography", e.target.value)}
          />
        </label>
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
        <label className="check-field">
          <input
            type="checkbox"
            checked={!!draft.parentageComplete}
            onChange={(e) => field("parentageComplete", e.target.checked)}
          />{" "}
          Все кровные родители известны и указаны
        </label>
        <details>
          <summary>Расположение на древе</summary>
          <div className="form-grid">
            <label>
              Поколение
              <input
                type="number"
                min="1"
                value={draft.generation}
                onChange={(e) => field("generation", Number(e.target.value))}
              />
            </label>
            {person && (
              <label>
                Колонка
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={draft.column}
                  onChange={(e) => field("column", Number(e.target.value))}
                />
              </label>
            )}
          </div>
        </details>
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
