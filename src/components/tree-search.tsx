import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { fullName, years, matchesPerson, type Person } from "../domain";

export function TreeSearch({
  people,
  query,
  onQuery,
  onSelect,
}: {
  people: Person[];
  query: string;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        !(e.target as HTMLElement).closest("[role=dialog], dialog") &&
        (e.target === ref.current ||
          !(e.target as HTMLElement).closest(
            "input,textarea,select,[contenteditable]",
          ))
      ) {
        onQuery("");
        setOpen(false);
      }
      if (
        e.key === "/" &&
        !e.defaultPrevented &&
        !(e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable],[role=dialog],dialog",
        )
      ) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onQuery]);
  const matches = query.trim()
    ? people.filter((p) => matchesPerson(p, query)).slice(0, 8)
    : [];
  const clearQuery = () => {
    onQuery("");
    setOpen(false);
    ref.current?.focus();
  };
  return (
    <div
      className="archive-search"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <Search size={19} aria-hidden="true" />
      <input
        ref={ref}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setActive((index) =>
              matches.length
                ? (index + (e.key === "ArrowDown" ? 1 : matches.length - 1)) %
                  matches.length
                : 0,
            );
          }
          if (e.key === "Enter" && matches[active]) {
            e.preventDefault();
            onSelect(matches[active].id);
            setOpen(false);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onQuery("");
            setOpen(false);
          }
        }}
        placeholder="Найти человека…"
        aria-label="Найти человека"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && !!query.trim()}
        aria-controls={open && query.trim() ? `${id}-options` : undefined}
        aria-activedescendant={
          open && matches[active] ? `${id}-option-${active}` : undefined
        }
      />
      <kbd>/</kbd>
      {query && (
        <button
          type="button"
          className="archive-search-clear"
          aria-label="Очистить поиск"
          title="Очистить поиск"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clearQuery}
        >
          <X size={17} aria-hidden="true" />
        </button>
      )}
      {open && query.trim() && (
        <div
          className="archive-search-results"
          id={`${id}-options`}
          role="listbox"
          aria-label="Найденные люди"
        >
          {matches.length ? (
            matches.map((p, index) => (
              <button
                key={p.id}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={active === index}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onSelect(p.id);
                  setOpen(false);
                }}
              >
                <b>{fullName(p)}</b>
                {years(p) && <small>{years(p)}</small>}
              </button>
            ))
          ) : (
            <p>Никого не нашли</p>
          )}
        </div>
      )}
    </div>
  );
}
