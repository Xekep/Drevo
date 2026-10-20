import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, SlidersHorizontal, Trash2, X, BookmarkPlus } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch.ts";
import {
  buildPeopleCriteria,
  peopleCriteriaRows,
  peopleFilterFields,
  filterRelations,
  type PeopleFilterMode,
  type PeopleFilterRow,
} from "../domain/people-filter-builder.ts";
import type { Person } from "../domain/types.ts";
import type { SavedPeopleFilter } from "../shared/personal-research.ts";
import { PersonSearch } from "./person-search";
import "../styles/personal-research.css";

export function PeopleFilterBuilder({
  people,
  revision,
  personal,
  onResults,
}: {
  people: Person[];
  revision: number;
  personal: boolean;
  onResults: (ids: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PeopleFilterRow[]>([
    { key: "first", field: "surname", value: "" },
  ]);
  const [mode, setMode] = useState<PeopleFilterMode>("allOf");
  const [applied, setApplied] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState<{
    criteria: Record<string, unknown>;
    revision: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedPeopleFilter[]>([]);
  const [savedError, setSavedError] = useState("");
  const [name, setName] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const busy =
    !!applied &&
    (fetched?.criteria !== applied || fetched?.revision !== revision);
  const draft = useMemo(() => {
    try {
      return buildPeopleCriteria(rows, mode);
    } catch {
      return null;
    }
  }, [rows, mode]);
  const appliedDraft =
    !!draft && JSON.stringify(draft) === JSON.stringify(applied);
  useEffect(() => {
    if (!personal || !open) return;
    const controller = new AbortController();
    void archiveFetch("/api/people-filters", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (!controller.signal.aborted) {
          setSaved(data.items);
          setSavedError("");
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setSavedError(reason.message);
      });
    return () => controller.abort();
  }, [personal, open]);
  useEffect(() => {
    request.current?.abort();
    if (!applied) return;
    const controller = new AbortController();
    request.current = controller;
    void archiveFetch("/api/people/filter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ criteria: applied }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Поиск не выполнился");
        if (!controller.signal.aborted) {
          onResults(data.personIds);
          setCount(data.personIds.length);
          setError("");
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
          onResults([]);
          setCount(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted)
          setFetched({ criteria: applied, revision });
      });
    return () => controller.abort();
  }, [applied, revision, onResults]);
  const edit = (key: string, change: Partial<PeopleFilterRow>) =>
    setRows((previous) =>
      previous.map((row) => (row.key === key ? { ...row, ...change } : row)),
    );
  const apply = () => {
    try {
      setApplied(buildPeopleCriteria(rows, mode));
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  async function save(remove?: string) {
    if (saving) return;
    setSaving(true);
    setSavedError("");
    try {
      if (!remove && (!applied || !appliedDraft))
        throw new Error("Сначала примените условия поиска");
      const response = await archiveFetch("/api/people-filters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          remove ? { remove: true, id: remove } : { name, criteria: applied },
        ),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Поиск не сохранился");
      setSaved(data.items);
      if (!remove) setName("");
    } catch (reason) {
      setSavedError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="people-filter-builder">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontal size={16} />
        Условия поиска{applied ? ` · ${busy ? "…" : (count ?? "—")}` : ""}
      </button>
      {applied && (
        <button
          type="button"
          className="filter-reset"
          onClick={() => {
            request.current?.abort();
            setApplied(null);
            setError("");
            setCount(null);
            onResults(null);
          }}
        >
          <X size={14} />
          Сбросить
        </button>
      )}
      {open && (
        <div className="people-filter-panel">
          <label className="filter-mode">
            Найти людей, для которых выполняются
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as PeopleFilterMode)
              }
              aria-label="Объединение условий"
            >
              <option value="allOf">Все условия</option>
              <option value="anyOf">Хотя бы одно условие</option>
              <option value="noneOf">Ни одно из условий</option>
            </select>
          </label>
          <div className="people-filter-rows">
            {rows.map((row, index) => {
              const type = peopleFilterFields.find(
                ([field]) => field === row.field,
              )![2];
              return (
                <div className="people-filter-row" key={row.key}>
                  <select
                    aria-label={`Условие ${index + 1}`}
                    value={row.field}
                    onChange={(event) => {
                      const field = event.target
                        .value as PeopleFilterRow["field"];
                      const kind = peopleFilterFields.find(
                        ([key]) => key === field,
                      )![2];
                      edit(row.key, {
                        field,
                        value:
                          kind === "boolean"
                            ? "true"
                            : kind === "sex"
                              ? "m"
                              : kind === "relation"
                                ? "ancestors"
                                : "",
                        personId: undefined,
                      });
                    }}
                  >
                    {peopleFilterFields.map(([field, label]) => (
                      <option key={field} value={field}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {type === "boolean" ||
                  type === "sex" ||
                  type === "relation" ? (
                    <select
                      aria-label={`Значение условия ${index + 1}`}
                      value={row.value}
                      onChange={(event) =>
                        edit(row.key, { value: event.target.value })
                      }
                    >
                      {(type === "boolean"
                        ? [
                            ["true", "Да"],
                            ["false", "Нет"],
                          ]
                        : type === "sex"
                          ? [
                              ["m", "Мужской"],
                              ["f", "Женский"],
                              ["u", "Не указан"],
                            ]
                          : filterRelations
                      ).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={`Значение условия ${index + 1}`}
                      type={type === "year" ? "number" : "text"}
                      {...(type === "year"
                        ? { min: 1, max: 9999, step: 1 }
                        : { maxLength: 200 })}
                      value={row.value}
                      onChange={(event) =>
                        edit(row.key, { value: event.target.value })
                      }
                    />
                  )}
                  {type === "relation" && (
                    <PersonSearch
                      label="Относительно человека"
                      value={row.personId || ""}
                      selected={people.find(
                        (person) => person.id === row.personId,
                      )}
                      people={people}
                      onChange={(id) => edit(row.key, { personId: id })}
                    />
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    disabled={rows.length === 1}
                    aria-label={`Удалить условие ${index + 1}`}
                    onClick={() =>
                      setRows((previous) =>
                        previous.filter((item) => item.key !== row.key),
                      )
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="filter-actions">
            <button
              type="button"
              disabled={rows.length >= 10}
              onClick={() =>
                setRows((previous) => [
                  ...previous,
                  { key: crypto.randomUUID(), field: "surname", value: "" },
                ])
              }
            >
              <Plus size={15} />
              Условие
            </button>
            <button
              className="primary-action"
              type="button"
              disabled={busy}
              onClick={apply}
            >
              {busy ? "Ищем…" : "Применить"}
            </button>
            {count !== null && !busy && (
              <span role="status">Найдено: {count}</span>
            )}
          </div>
          {personal && (
            <div className="saved-people-filters">
              {applied && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <input
                    aria-label="Название сохранённого поиска"
                    placeholder="Название поиска"
                    maxLength={80}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <button
                    type="submit"
                    disabled={saving || !name.trim() || busy || !appliedDraft}
                  >
                    <BookmarkPlus size={15} />
                    Сохранить поиск
                  </button>
                </form>
              )}
              {saved.length > 0 && (
                <ul>
                  {saved.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            const parsed = peopleCriteriaRows(item.criteria);
                            setRows(parsed.rows);
                            setMode(parsed.mode);
                            setApplied(structuredClone(item.criteria));
                            setError("");
                          } catch (reason) {
                            setError((reason as Error).message);
                          }
                        }}
                      >
                        {item.name}
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={saving}
                        aria-label={`Удалить поиск: ${item.name}`}
                        onClick={() => void save(item.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {savedError && (
                <p role="alert" className="form-error">
                  {savedError}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
