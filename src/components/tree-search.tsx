import { useEffect, useId, useRef, useState } from "react";
import { FileText, Search, X } from "lucide-react";
import { fullName, years, matchesPerson, type Person } from "../domain";
import { archiveFetch } from "../data/archive-fetch.ts";

type DocumentMatch = { id: string; title: string };
type DocumentResults = {
  query: string;
  items: DocumentMatch[];
  failed: boolean;
};

export function TreeSearch({
  people,
  query,
  onQuery,
  onSelect,
  onSelectDocument,
}: {
  people: Person[];
  query: string;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
  onSelectDocument?: (id: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    ref = useRef<HTMLInputElement>(null);
  const selectedQuery = useRef<string | null>(null);
  const [documentResults, setDocumentResults] =
    useState<DocumentResults | null>(null);
  const search = query.trim();
  const searchDocuments = !!onSelectDocument && search.length >= 2;
  useEffect(() => {
    if (!searchDocuments) return;
    const request = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await archiveFetch(
            `/api/documents?limit=6&q=${encodeURIComponent(search)}`,
            { signal: request.signal },
          );
          if (!response.ok) throw new Error("Document search failed");
          const page = (await response.json()) as { items: DocumentMatch[] };
          if (!request.signal.aborted)
            setDocumentResults({
              query: search,
              items: page.items,
              failed: false,
            });
        } catch {
          if (!request.signal.aborted)
            setDocumentResults({ query: search, items: [], failed: true });
        }
      })();
    }, 250);
    return () => {
      window.clearTimeout(timer);
      request.abort();
    };
  }, [searchDocuments, search]);
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
        selectedQuery.current = null;
        setOpen(true);
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onQuery]);
  const matches = search
    ? people.filter((p) => matchesPerson(p, search)).slice(0, 8)
    : [];
  const documents =
    searchDocuments && documentResults?.query === search
      ? documentResults.items
      : [];
  const options = [
    ...matches.map((person) => ({ kind: "person" as const, person })),
    ...documents.map((document) => ({ kind: "document" as const, document })),
  ];
  const activeIndex = options.length ? active % options.length : 0;
  const choose = (option: (typeof options)[number]) => {
    selectedQuery.current = query;
    if (option.kind === "person") onSelect(option.person.id);
    else {
      onSelectDocument?.(option.document.id);
      onQuery("");
    }
    setOpen(false);
  };
  const documentPending = searchDocuments && documentResults?.query !== search;
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
        onFocus={() => {
          if (selectedQuery.current !== query) setOpen(true);
        }}
        onPointerDown={() => {
          selectedQuery.current = null;
          setOpen(true);
        }}
        onChange={(e) => {
          selectedQuery.current = null;
          onQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            selectedQuery.current = null;
            setOpen(true);
            setActive((index) =>
              options.length
                ? (index + (e.key === "ArrowDown" ? 1 : options.length - 1)) %
                  options.length
                : 0,
            );
          }
          if (e.key === "Enter" && options[activeIndex]) {
            e.preventDefault();
            choose(options[activeIndex]);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onQuery("");
            setOpen(false);
          }
        }}
        placeholder={
          onSelectDocument ? "Найти человека или документ…" : "Найти человека…"
        }
        aria-label={
          onSelectDocument ? "Найти человека или документ" : "Найти человека"
        }
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && !!query.trim()}
        aria-controls={open && query.trim() ? `${id}-options` : undefined}
        aria-activedescendant={
          open && options[activeIndex]
            ? `${id}-option-${activeIndex}`
            : undefined
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
          aria-label={
            onSelectDocument ? "Найденные люди и документы" : "Найденные люди"
          }
        >
          {options.map((option, index) => (
            <button
              key={
                option.kind === "person"
                  ? `person:${option.person.id}`
                  : `document:${option.document.id}`
              }
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={activeIndex === index}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              {option.kind === "person" ? (
                <>
                  <b>{fullName(option.person)}</b>
                  {years(option.person) && (
                    <small>{years(option.person)}</small>
                  )}
                </>
              ) : (
                <>
                  <b>
                    <FileText size={15} aria-hidden="true" />
                    {option.document.title}
                  </b>
                  <small>Документ</small>
                </>
              )}
            </button>
          ))}
          {!options.length && (
            <p role="status">
              {documentPending
                ? "Ищем документы…"
                : documentResults?.query === search && documentResults.failed
                  ? "Поиск документов сейчас недоступен"
                  : onSelectDocument ? "Ничего не нашли" : "Никого не нашли"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
