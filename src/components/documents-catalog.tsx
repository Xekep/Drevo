import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { BookOpenText, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { PdfBookReader } from "./pdf-book-reader";
import { fullName, type Person } from "../domain";
import "../styles/documents.css";

export type ListedDocument = {
  id: string;
  title: string;
  url: string;
  size: number;
  createdAt: string;
  canDelete?: boolean;
  people: Array<{ id: string; name: string }>;
};

type DocumentPage = { items: ListedDocument[]; total: number };
const PAGE_SIZE = 30;

type PersonOption = { id: string; label: string; detail: string };

export function DocumentsCatalog({
  mayEdit,
  personFilter,
  people,
}: {
  mayEdit: boolean;
  personFilter: string | null;
  people: Person[];
}) {
  const [documents, setDocuments] = useState<ListedDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ListedDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [personResults, setPersonResults] = useState<PersonOption[]>([]);
  const [selectedPeople, setSelectedPeople] = useState<PersonOption[]>([]);
  const filteredPerson = people.find((person) => person.id === personFilter);

  const load = useCallback(
    async (offset: number) => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      if (!offset) {
        setDocuments([]);
        setTotal(0);
      }
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/documents?offset=${offset}&limit=${PAGE_SIZE}&q=${encodeURIComponent(query.trim())}${personFilter !== null ? `&personId=${encodeURIComponent(personFilter)}` : ""}`,
          { signal: request.signal },
        );
        if (!response.ok) throw new Error("Не удалось загрузить документы");
        const page = (await response.json()) as DocumentPage;
        if (request.signal.aborted) return;
        setTotal(page.total);
        setDocuments((current) =>
          offset ? [...current, ...page.items] : page.items,
        );
      } catch (reason) {
        if (!request.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить документы",
          );
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    },
    [query, personFilter],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(0), query ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.current?.abort();
    };
  }, [load, query]);

  useEffect(() => {
    if (personQuery.trim().length < 2) return;
    const request = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/people/search?q=${encodeURIComponent(personQuery.trim())}`,
          { signal: request.signal },
        );
        if (!response.ok) return;
        const result = (await response.json()) as { people: PersonOption[] };
        if (!request.signal.aborted) setPersonResults(result.people);
      } catch {
        if (!request.signal.aborted) setPersonResults([]);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      request.abort();
    };
  }, [personQuery]);

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || !title.trim() || !selectedPeople.length) return;
    setUploading(true);
    setUploadError("");
    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "X-Document-Metadata": encodeURIComponent(
            JSON.stringify({
              title: title.trim(),
              personIds: selectedPeople.map((person) => person.id),
            }),
          ),
        },
        body: file,
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Не удалось загрузить документ");
      }
      setUploadOpen(false);
      setFile(null);
      setTitle("");
      setPersonQuery("");
      setSelectedPeople([]);
      void load(0);
    } catch (reason) {
      setUploadError(
        reason instanceof Error
          ? reason.message
          : "Не удалось загрузить документ",
      );
    } finally {
      setUploading(false);
    }
  };

  const groups = useMemo(() => {
    const grouped = new Map<
      string,
      { name: string; items: ListedDocument[] }
    >();
    for (const document of documents) {
      if (personFilter !== null) {
        const person = document.people.find((item) => item.id === personFilter);
        if (person) {
          const group = grouped.get(person.id) || {
            name: person.name,
            items: [],
          };
          group.items.push(document);
          grouped.set(person.id, group);
        }
        continue;
      }
      if (!document.people.length) {
        const group = grouped.get("") || { name: "Без привязки", items: [] };
        group.items.push(document);
        grouped.set("", group);
      }
      for (const person of document.people) {
        const group = grouped.get(person.id) || {
          name: person.name,
          items: [],
        };
        group.items.push(document);
        grouped.set(person.id, group);
      }
    }
    return [...grouped.entries()].sort((a, b) =>
      a[1].name.localeCompare(b[1].name, "ru"),
    );
  }, [documents, personFilter]);

  const remove = async (entry: ListedDocument) => {
    if (
      deleting ||
      !window.confirm(
        `Удалить документ «${entry.title}»? PDF и его привязки к людям будут удалены из архива.`,
      )
    )
      return;
    setDeleting(entry.id);
    setDeleteError("");
    try {
      const response = await fetch(`/api/documents/${entry.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Не удалось удалить документ");
      }
      setSelected((current) => (current?.id === entry.id ? null : current));
      await load(0);
    } catch (reason) {
      setDeleteError(
        reason instanceof Error
          ? reason.message
          : "Не удалось удалить документ",
      );
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section className="documents-catalog">
      <header className="documents-heading">
        <div>
          <span className="documents-eyebrow">Семейный архив</span>
          <h1>Документы</h1>
          <p>
            {personFilter !== null
              ? `PDF-документы, связанные с ${filteredPerson ? fullName(filteredPerson) : "выбранным человеком"}.`
              : "Загруженные участниками PDF-документы, связанные с людьми в архиве."}
          </p>
          {personFilter !== null && (
            <a className="documents-clear-filter" href="/documents">
              Показать все документы
            </a>
          )}
        </div>
        <div className="documents-heading-actions">
          {total > 0 && (
            <span className="documents-count">{total} документов</span>
          )}
          {mayEdit && (
            <button
              type="button"
              className="documents-add"
              onClick={() => {
                if (!uploadOpen && filteredPerson && !selectedPeople.length)
                  setSelectedPeople([
                    {
                      id: filteredPerson.id,
                      label: fullName(filteredPerson),
                      detail: "",
                    },
                  ]);
                setUploadOpen((open) => !open);
              }}
              aria-expanded={uploadOpen}
            >
              <Plus size={18} /> Добавить PDF
            </button>
          )}
        </div>
      </header>
      {uploadOpen && (
        <form
          className="documents-upload"
          onSubmit={(event) => void upload(event)}
        >
          <div className="documents-upload-heading">
            <h2>Новый документ</h2>
            <button
              type="button"
              onClick={() => setUploadOpen(false)}
              aria-label="Закрыть форму"
            >
              <X size={18} />
            </button>
          </div>
          <label>
            PDF-файл · до 20 МБ
            <input
              type="file"
              accept=".pdf,application/pdf"
              required
              onChange={(event) => {
                const next = event.target.files?.[0] || null;
                setFile(next);
                if (next && !title) setTitle(next.name.replace(/\.pdf$/i, ""));
              }}
            />
          </label>
          <label>
            Название
            <input
              value={title}
              maxLength={160}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            К кому относится
            <input
              value={personQuery}
              onChange={(event) => {
                setPersonQuery(event.target.value);
                setPersonResults([]);
              }}
              placeholder="Начните вводить имя"
              aria-label="Найти человека для документа"
            />
          </label>
          {personResults.length > 0 && personQuery.trim().length > 1 && (
            <div
              className="documents-person-results"
              role="listbox"
              aria-label="Найденные люди"
            >
              {personResults
                .filter(
                  (person) =>
                    !selectedPeople.some((item) => item.id === person.id),
                )
                .map((person) => (
                  <button
                    type="button"
                    key={person.id}
                    onClick={() => {
                      setSelectedPeople((current) => [...current, person]);
                      setPersonQuery("");
                      setPersonResults([]);
                    }}
                  >
                    <strong>{person.label}</strong>
                    <small>{person.detail}</small>
                  </button>
                ))}
            </div>
          )}
          <div className="documents-selected-people">
            {selectedPeople.map((person) => (
              <span key={person.id}>
                {person.label}
                <button
                  type="button"
                  aria-label={`Убрать ${person.label}`}
                  onClick={() =>
                    setSelectedPeople((current) =>
                      current.filter((item) => item.id !== person.id),
                    )
                  }
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
          {uploadError && (
            <p role="alert" className="documents-upload-error">
              {uploadError}
            </p>
          )}
          <button
            type="submit"
            className="documents-upload-submit"
            disabled={
              uploading || !file || !title.trim() || !selectedPeople.length
            }
          >
            <Upload size={18} />{" "}
            {uploading ? "Загружаем…" : "Добавить документ"}
          </button>
        </form>
      )}
      {(total > 0 || !!query) && (
        <label className="documents-search">
          <Search size={18} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти документ или человека"
            aria-label="Найти документ или человека"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Очистить поиск"
            >
              <X size={16} />
            </button>
          )}
        </label>
      )}
      {error && (
        <div className="documents-state" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void load(documents.length)}>
            Повторить
          </button>
        </div>
      )}
      {!error && loading && !documents.length && (
        <p className="documents-state" role="status">
          Загружаем документы…
        </p>
      )}
      {!error && !loading && !documents.length && !query && (
        <div className="documents-state documents-empty">
          <BookOpenText size={38} strokeWidth={1.4} aria-hidden="true" />
          <h2>Документов пока нет</h2>
          <p>
            {personFilter !== null
              ? "К этому человеку пока не привязан ни один PDF-документ."
              : "Загруженные PDF-файлы появятся здесь после привязки к людям."}
          </p>
        </div>
      )}
      {!error && !loading && !documents.length && !!query && (
        <p className="documents-state">По запросу ничего не найдено.</p>
      )}
      <div className="documents-groups">
        {deleteError && !selected && (
          <p role="alert" className="documents-upload-error">
            {deleteError}
          </p>
        )}
        {groups.map(([personId, group]) => (
          <section className="documents-group" key={personId}>
            <div className="documents-group-heading">
              <h2>{group.name}</h2>
              <span>{group.items.length}</span>
            </div>
            <div className="documents-grid">
              {group.items.map((document) => (
                <div className="document-item-row" key={document.id}>
                  <button
                    type="button"
                    className="document-item"
                    onClick={() => {
                      setDeleteError("");
                      setSelected(document);
                    }}
                  >
                    <span className="document-item-icon">
                      <BookOpenText size={25} strokeWidth={1.5} />
                    </span>
                    <span className="document-item-text">
                      <strong>{document.title}</strong>
                      <small>PDF · Открыть книгу</small>
                    </span>
                  </button>
                  {mayEdit && document.canDelete && (
                    <button
                      type="button"
                      className="document-delete"
                      aria-label={`Удалить документ «${document.title}»`}
                      title="Удалить документ"
                      disabled={deleting !== null}
                      onClick={() => void remove(document)}
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {documents.length < total && (
        <button
          type="button"
          className="documents-more"
          disabled={loading}
          onClick={() => void load(documents.length)}
        >
          {loading
            ? "Загружаем…"
            : `Показать ещё · ${total - documents.length}`}
        </button>
      )}
      {selected && (
        <PdfBookReader
          document={selected}
          onClose={() => setSelected(null)}
          onDelete={
            mayEdit && selected.canDelete
              ? () => void remove(selected)
              : undefined
          }
          deleting={deleting === selected.id}
          deleteError={deleteError}
        />
      )}
    </section>
  );
}
