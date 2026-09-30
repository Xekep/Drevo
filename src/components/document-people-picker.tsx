import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch";

export type DocumentPerson = { id: string; name: string };

export function DocumentPeoplePicker({
  value,
  onChange,
  optional = true,
  disabled = false,
}: {
  value: DocumentPerson[];
  onChange: (people: DocumentPerson[]) => void;
  optional?: boolean;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    Array<{ id: string; label: string; detail: string }>
  >([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (query.trim().length < 2) return;
    const request = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await archiveFetch(
          `/api/people/search?q=${encodeURIComponent(query.trim())}`,
          { signal: request.signal },
        );
        if (!response.ok)
          throw new Error("Не удалось найти людей. Попробуйте ещё раз");
        const data = (await response.json()) as { people: typeof results };
        if (!request.signal.aborted) setResults(data.people);
      } catch (reason) {
        if (!request.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "Не удалось найти людей",
          );
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      request.abort();
    };
  }, [query]);
  return (
    <div className="document-people-picker">
      <label>
        К кому относится{optional ? " · необязательно" : ""}
        <input
          value={query}
          disabled={disabled || value.length >= 30}
          maxLength={100}
          placeholder="Начните вводить имя"
          aria-label="Найти человека для документа"
          onChange={(event) => {
            setQuery(event.target.value);
            setResults([]);
            setError("");
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {query.trim().length > 1 && results.length > 0 && (
        <div className="documents-person-results" aria-label="Найденные люди">
          {results
            .filter((person) => !value.some((item) => item.id === person.id))
            .map((person) => (
              <button
                type="button"
                key={person.id}
                disabled={disabled || value.length >= 30}
                onClick={() => {
                  onChange([...value, { id: person.id, name: person.label }]);
                  setQuery("");
                  setResults([]);
                }}
              >
                <strong>{person.label}</strong>
                <small>{person.detail}</small>
              </button>
            ))}
        </div>
      )}
      <div className="documents-selected-people">
        {value.map((person) => (
          <span key={person.id}>
            {person.name}
            <button
              type="button"
              disabled={disabled}
              aria-label={`Убрать ${person.name}`}
              onClick={() =>
                onChange(value.filter((item) => item.id !== person.id))
              }
            >
              <X size={14} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
