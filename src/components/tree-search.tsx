import { useEffect, useId, useRef, useState } from "react";
import { FileText, Globe, Search, X } from "lucide-react";
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
  globalSearch = false,
}: {
  people: Person[];
  query: string;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
  onSelectDocument?: (id: string) => void;
  globalSearch?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [active, setActive] = useState<number | "global">(0),
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
  const localOptions = [
    ...matches.map((person) => ({ kind: "person" as const, person })),
    ...documents.map((document) => ({ kind: "document" as const, document })),
  ];
  let globalQuery = "";
  for (const character of search) {
    if (globalQuery.length + character.length > 100) break;
    globalQuery += character;
  }
  const globalHref =
    globalQuery.length >= 2
      ? `/discover/search/${encodeURIComponent(globalQuery)}`
      : "/discover";
  const options = [
    ...localOptions,
    ...(globalSearch ? [{ kind: "global" as const, href: globalHref }] : []),
  ];
  const showResults = open && (!!search || globalSearch);
  const activeIndex =
    active === "global"
      ? Math.max(
          0,
          options.findIndex((option) => option.kind === "global"),
        )
      : options.length
        ? active % options.length
        : 0;
  const choose = (option: (typeof options)[number]) => {
    selectedQuery.current = query;
    if (option.kind === "person") onSelect(option.person.id);
    else if (option.kind === "global") window.location.assign(option.href);
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
          const nextSearch = e.target.value.trim();
          const hasLocalMatch =
            !!nextSearch &&
            (people.some((person) => matchesPerson(person, nextSearch)) ||
              (documentResults?.query === nextSearch &&
                documentResults.items.length > 0));
          selectedQuery.current = null;
          onQuery(e.target.value);
          setActive(globalSearch && !hasLocalMatch ? "global" : 0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            selectedQuery.current = null;
            setOpen(true);
            const next = options.length
              ? (activeIndex +
                  (e.key === "ArrowDown" ? 1 : options.length - 1)) %
                options.length
              : 0;
            setActive(options[next]?.kind === "global" ? "global" : next);
          }
          if (e.key === "Enter" && showResults && options[activeIndex]) {
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
        aria-expanded={showResults}
        aria-controls={showResults ? `${id}-options` : undefined}
        aria-activedescendant={
          showResults && options[activeIndex]
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
      {showResults && (
        <div
          className="archive-search-results"
          id={`${id}-options`}
          role="listbox"
          aria-label={
            onSelectDocument ? "Найденные люди и документы" : "Найденные люди"
          }
        >
          {!localOptions.length && search && (
            <p role="status">
              {documentPending
                ? "Ищем документы…"
                : documentResults?.query === search && documentResults.failed
                  ? "Поиск документов сейчас недоступен"
                  : onSelectDocument
                    ? "Ничего не нашли"
                    : "Никого не нашли"}
            </p>
          )}
          {options.map((option, index) =>
            option.kind === "global" ? (
              <a
                key="global"
                href={option.href}
                className="archive-search-global"
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={activeIndex === index}
                tabIndex={-1}
                onMouseDown={(event) => {
                  if (event.button === 0) event.preventDefault();
                }}
              >
                <b>
                  <Globe size={15} aria-hidden="true" />
                  Глобальный поиск
                </b>
                <small>Опубликованные люди всех архивов</small>
              </a>
            ) : (
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
            ),
          )}
        </div>
      )}
    </div>
  );
}
