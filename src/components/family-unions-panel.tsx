import { useState } from "react";
import {
  fullName,
  unionStatus,
  type ArchiveUser,
  type Family,
  type FamilyUnion,
  type Source,
  type UnionMilestone,
} from "../domain";

const names = {
  marriage: "Брак",
  civil_union: "Гражданский союз",
  partnership: "Партнёрство",
} as const;
const statusNames = {
  current: "Действует по подтверждению",
  former: "Завершён",
  unknown: "Статус неизвестен",
} as const;
const empty = (participants: [string, string]): FamilyUnion => ({
  id: crypto.randomUUID(),
  participants,
  type: "marriage",
});

export function FamilyUnionsPanel({
  family,
  participants,
  user,
  editable,
  save,
  busy,
  onSaved,
}: {
  family: Family;
  participants: [string, string];
  user: ArchiveUser | null;
  editable: boolean;
  save: (family: Family) => Promise<Family>;
  busy: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<FamilyUnion | null>(null);
  const [error, setError] = useState("");
  const unions = (family.unions || []).filter((union) =>
    participants.every((id) => union.participants.includes(id)),
  );
  const people = participants.map((id) =>
    family.people.find((person) => person.id === id),
  );
  const mayCreate =
    editable &&
    !!user &&
    (user.role === "admin" ||
      people.every((person) => person?.createdBy === user.id));
  const mayEdit = (union: FamilyUnion) =>
    mayCreate && (user?.role === "admin" || union.createdBy === user?.id);
  const patch = (value: Partial<FamilyUnion>) =>
    setDraft((old) => old && { ...old, ...value });
  const milestone = (
    key: "formation" | "ending" | "divorce" | "ongoing",
    field: keyof UnionMilestone,
    value: string,
  ) =>
    setDraft(
      (old) =>
        old && {
          ...old,
          ...(value && key === "ending" ? { divorce: undefined } : {}),
          ...(value && key === "divorce" ? { ending: undefined } : {}),
          [key]: { ...old[key], [field]: value || undefined },
        },
    );
  const submit = async (remove = false) => {
    if (!draft) return;
    setError("");
    try {
      const next = (family.unions || []).filter(
        (union) => union.id !== draft.id,
      );
      if (!remove) next.push(draft);
      await save({ ...family, unions: next });
      setDraft(null);
      onSaved();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  return (
    <section
      className="archive-form family-unions-panel"
      aria-label="Семейные союзы"
    >
      <h3>Семейные союзы</h3>
      <p>
        События в карточке человека без указанного партнёра не определяют статус
        этого союза.
      </p>
      {unions.map((union) => (
        <div key={union.id} className="event-card">
          <strong>
            {names[union.type]} · {statusNames[unionStatus(union)]}
          </strong>
          <p>
            {union.formation?.dateText ||
              union.formation?.date ||
              "Дата заключения неизвестна"}
            {union.formation?.place ? ` · ${union.formation.place}` : ""}
          </p>
          {(union.divorce || union.ending) && (
            <p>
              {union.divorce ? "Развод" : "Окончание"}:{" "}
              {(union.divorce || union.ending)?.dateText ||
                (union.divorce || union.ending)?.date ||
                "дата неизвестна"}
            </p>
          )}
          {union.note && <p>{union.note}</p>}
          {mayEdit(union) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setDraft(structuredClone(union))}
            >
              Изменить союз
            </button>
          )}
        </div>
      ))}
      {!unions.length && <p>Для этой пары союз ещё не описан.</p>}
      {mayCreate && !draft && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setDraft(empty(participants))}
        >
          Добавить союз
        </button>
      )}
      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p>
            {people
              .map((person) => (person ? fullName(person) : ""))
              .join(" — ")}
          </p>
          <label>
            Тип союза
            <select
              value={draft.type}
              onChange={(event) =>
                patch({
                  type: event.target.value as FamilyUnion["type"],
                  divorce:
                    event.target.value === "marriage"
                      ? draft.divorce
                      : undefined,
                })
              }
            >
              {Object.entries(names).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {(["formation", "ending", "divorce", "ongoing"] as const)
            .filter((key) => key !== "divorce" || draft.type === "marriage")
            .map((key) => (
              <fieldset key={key}>
                <legend>
                  {
                    {
                      formation: "Заключение",
                      ending: "Окончание",
                      divorce: "Развод",
                      ongoing: "Подтверждение действующего союза",
                    }[key]
                  }
                </legend>
                <label>
                  Дата (год, месяц или день)
                  <input
                    value={draft[key]?.date || ""}
                    onChange={(event) =>
                      milestone(key, "date", event.target.value)
                    }
                    placeholder="1900-05-12"
                  />
                </label>
                {key === "ongoing" && (
                  <button
                    type="button"
                    onClick={() =>
                      milestone(
                        "ongoing",
                        "date",
                        new Date().toISOString().slice(0, 10),
                      )
                    }
                  >
                    Подтвердить на сегодня
                  </button>
                )}
                <label>
                  Приблизительная дата
                  <input
                    value={draft[key]?.dateText || ""}
                    onChange={(event) =>
                      milestone(key, "dateText", event.target.value)
                    }
                    placeholder="около 1900 года"
                  />
                </label>
                <label>
                  Место
                  <input
                    value={draft[key]?.place || ""}
                    onChange={(event) =>
                      milestone(key, "place", event.target.value)
                    }
                  />
                </label>
              </fieldset>
            ))}
          <label>
            Примечание
            <textarea
              value={draft.note || ""}
              onChange={(event) => patch({ note: event.target.value })}
            />
          </label>
          <fieldset>
            <legend>Источники</legend>
            {(draft.sources || []).map((source, index) => (
              <div key={index}>
                {(["title", "type", "reference", "url"] as const).map(
                  (field) => (
                    <label key={field}>
                      {
                        {
                          title: "Название",
                          type: "Тип",
                          reference: "Ссылка в источнике",
                          url: "URL",
                        }[field]
                      }
                      <input
                        value={source[field] || ""}
                        onChange={(event) =>
                          patch({
                            sources: draft.sources!.map((item, i) =>
                              i === index
                                ? { ...item, [field]: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                  ),
                )}
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      sources: draft.sources!.filter((_, i) => i !== index),
                    })
                  }
                >
                  Удалить источник
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                patch({
                  sources: [
                    ...(draft.sources || []),
                    { title: "", type: "", reference: "" } satisfies Source,
                  ],
                })
              }
            >
              Добавить источник
            </button>
          </fieldset>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button className="primary-action" disabled={busy}>
            Сохранить союз
          </button>
          <button type="button" disabled={busy} onClick={() => setDraft(null)}>
            Отмена
          </button>
          {unions.some((union) => union.id === draft.id) && (
            <button
              type="button"
              className="danger-action"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              Удалить союз
            </button>
          )}
        </form>
      )}
    </section>
  );
}
