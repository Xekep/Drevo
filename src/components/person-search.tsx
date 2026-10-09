import { archiveFetch } from "../data/archive-fetch.ts";
import { useEffect, useId, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { fullName, type Person } from "../domain";
import { createPeopleSearch, type PersonOption } from "../domain/people-search";

export function PersonSearch({
  value,
  selected,
  onChange,
  onCommit,
  onCancel,
  disabled = false,
  label = "Кто это?",
  inputAriaLabel,
  clearLabel = "Выбрать другого человека",
  excludeId,
  people,
  showAllOnEmpty = false,
}: {
  value: string;
  selected?: Person;
  onChange: (id: string) => void;
  onCommit?: (id: string) => void;
  onCancel?: () => void;
  disabled?: boolean;
  label?: string;
  inputAriaLabel?: string;
  clearLabel?: string;
  excludeId?: string;
  /** Search only this accessible pool, without an authenticated API request. */
  people?: Person[];
  /** A small, already restricted list, such as the person's union partners. */
  showAllOnEmpty?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(-1),
    [picked, setPicked] = useState<PersonOption | null>(null),
    [attempt, setAttempt] = useState(0),
    [result, setResult] = useState<{
      query: string;
      people: PersonOption[];
      hasMore?: boolean;
      error?: string;
    }>({ query: "", people: [] });
  const needle = query.trim();
  const localSearch = useMemo(
    () => (people ? createPeopleSearch(people) : null),
    [people],
  );
  const searchResult = localSearch
    ? {
        query: needle,
        ...(showAllOnEmpty && !needle
          ? {
              people: (people || []).map((person) => ({
                id: person.id,
                label: fullName(person),
                detail: person.birth,
              })),
              hasMore: false,
            }
          : localSearch(needle)),
      }
    : result;
  useEffect(() => {
    if (localSearch || !open || disabled || value || needle.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await archiveFetch(
          `/api/people/search?q=${encodeURIComponent(needle)}`,
          { signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Поиск недоступен");
        if (!controller.signal.aborted)
          setResult({
            query: needle,
            people: data.people,
            hasMore: data.hasMore,
          });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            query: needle,
            people: [],
            error: (error as Error).message,
          });
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [needle, open, disabled, value, attempt, localSearch]);
  const options =
    searchResult.query === needle
      ? searchResult.people.filter((p) => p.id !== excludeId)
      : [];
  const visible = open && !value && !disabled;
  function choose(person: PersonOption) {
    setPicked(person);
    onChange(person.id);
    onCommit?.(person.id);
    setOpen(false);
    setActive(-1);
  }
  return (
    <div
      className="person-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          if (!value && (query.trim() || localSearch)) onCancel?.();
        }
      }}
    >
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className="person-search-input">
        <Search size={16} aria-hidden="true" />
        <input
          id={`${id}-input`}
          role="combobox"
          aria-label={inputAriaLabel}
          aria-autocomplete="list"
          autoComplete="off"
          aria-expanded={visible}
          aria-controls={visible ? `${id}-list` : undefined}
          aria-describedby={visible ? `${id}-status` : undefined}
          aria-activedescendant={
            visible && options[active] ? `${id}-${active}` : undefined
          }
          placeholder="Фамилия, имя или отчество"
          maxLength={100}
          disabled={disabled}
          value={
            value
              ? selected
                ? fullName(selected)
                : picked?.label || ""
              : query
          }
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onChange("");
            setPicked(null);
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
            setResult({ query: "", people: [] });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              if (!value && (query.trim() || localSearch)) onCancel?.();
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive((index) =>
                options.length
                  ? index < 0
                    ? event.key === "ArrowDown"
                      ? 0
                      : options.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : options.length - 1) +
                        options.length) %
                      options.length
                  : -1,
              );
            }
            if (event.key === "Enter" && visible) {
              event.preventDefault();
              if (options[active]) choose(options[active]);
            }
          }}
        />
        {value && (
          <button
            type="button"
            disabled={disabled}
            aria-label={clearLabel}
            onClick={() => {
              onChange("");
              onCommit?.("");
              setPicked(null);
              setQuery("");
              setOpen(true);
              setActive(-1);
              document.getElementById(`${id}-input`)?.focus();
            }}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {visible && (
        <div className="person-search-results">
          <ul id={`${id}-list`} role="listbox" aria-label="Найденные люди">
            {options.map((person, index) => (
              <li key={person.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`${id}-${index}`}
                  aria-selected={active === index}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(person)}
                >
                  <b>{person.label}</b>
                  {person.detail && <small>{person.detail}</small>}
                </button>
              </li>
            ))}
          </ul>
          <p id={`${id}-status`} role="status">
            {needle.length < 2 && !(showAllOnEmpty && !needle)
              ? "Введите хотя бы две буквы"
              : searchResult.query !== needle
                ? "Ищем…"
                : ("error" in searchResult && searchResult.error) ||
                  (!options.length
                    ? "Никого не найдено. Попробуйте другую часть ФИО."
                    : searchResult.hasMore
                      ? "Есть ещё совпадения — уточните запрос"
                      : `Найдено: ${options.length}`)}
          </p>
          {!localSearch && result.query === needle && result.error && (
            <button
              type="button"
              onClick={() => {
                setResult({ query: "", people: [] });
                setAttempt((n) => n + 1);
              }}
            >
              Повторить поиск
            </button>
          )}
        </div>
      )}
    </div>
  );
}
