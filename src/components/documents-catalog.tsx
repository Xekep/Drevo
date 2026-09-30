import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { BookOpenText, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { PdfBookReader } from "./pdf-book-reader";
import { DocumentDetailsFields } from "./document-details-fields";
import { fullName, type Person } from "../domain";
import type { DocumentDetails } from "../shared/document-details";
import "../styles/documents.css";

export type ListedDocument = DocumentDetails & {
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
const EMPTY_DETAILS: DocumentDetails = {
  documentType: "",
  documentDate: "",
  place: "",
  description: "",
  provenance: "",
};

type PersonOption = { id: string; label: string; detail: string };

export function DocumentsCatalog({
  mayEdit,
  allowUnlinked,
  personFilter,
  documentId,
  onSelectDocument,
  people,
}: {
  mayEdit: boolean;
  allowUnlinked: boolean;
  personFilter: string | null;
  documentId: string | null;
  onSelectDocument: (id: string | null) => void;
  people: Person[];
}) {
  const [documents, setDocuments] = useState<ListedDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ListedDocument | null>(null);
  const [annotateOnOpen, setAnnotateOnOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [directFailure, setDirectFailure] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState<DocumentDetails>(EMPTY_DETAILS);
  const [editing, setEditing] = useState<ListedDocument | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDetails, setEditDetails] = useState<DocumentDetails>(EMPTY_DETAILS);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");
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
    if (!documentId) return;
    if (selected?.id === documentId) return;
    if (!/^[a-f0-9-]{36}$/.test(documentId)) return;
    const request = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/documents/${documentId}`, {
          signal: request.signal,
        });
        if (!response.ok) throw new Error("Документ не найден или недоступен");
        const entry = (await response.json()) as ListedDocument;
        if (
          personFilter &&
          !entry.people.some((person) => person.id === personFilter)
        )
          throw new Error("Документ больше не связан с этим человеком");
        if (!request.signal.aborted) {
          setAnnotateOnOpen(false);
          setSelected(entry);
        }
      } catch (reason) {
        if (!request.signal.aborted)
          setDirectFailure({
            id: documentId,
            message:
              reason instanceof Error
                ? reason.message
                : "Не удалось открыть документ",
          });
      }
    })();
    return () => request.abort();
  }, [documentId, personFilter, selected?.id]);
  const directError =
    documentId && !/^[a-f0-9-]{36}$/.test(documentId)
      ? "Некорректная ссылка на документ"
      : directFailure?.id === documentId
        ? directFailure.message
        : "";
  const activeSelected = selected?.id === documentId ? selected : null;

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
    if (!file || !title.trim() || (!allowUnlinked && !selectedPeople.length))
      return;
    setUploading(true);
    setUploadError("");
    try {
      const metadata = JSON.stringify({
        title: title.trim(),
        personIds: selectedPeople.map((person) => person.id),
        ...details,
      });
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "X-Document-Metadata": `base64:${btoa(String.fromCharCode(...new TextEncoder().encode(metadata)))}`,
        },
        body: file,
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Не удалось загрузить документ");
      }
      const created = (await response.json()) as { id: string };
      setAnnotateOnOpen(true);
      setSelected({
        id: created.id,
        title: title.trim(),
        ...details,
        url: `/api/documents/${created.id}/file`,
        size: file.size,
        createdAt: new Date().toISOString(),
        canDelete: true,
        people: selectedPeople.map((person) => ({
          id: person.id,
          name: person.label,
        })),
      });
      onSelectDocument(created.id);
      setUploadOpen(false);
      setFile(null);
      setTitle("");
      setDetails(EMPTY_DETAILS);
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

  const beginEdit = (entry: ListedDocument) => {
    setUploadOpen(false);
    setSelected(null);
    onSelectDocument(null);
    setEditing(entry);
    setEditTitle(entry.title);
    setEditDetails({
      documentType: entry.documentType,
      documentDate: entry.documentDate,
      place: entry.place,
      description: entry.description,
      provenance: entry.provenance,
    });
    setEditError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || !editTitle.trim() || savingEdit) return;
    setSavingEdit(true);
    setEditError("");
    try {
      const response = await fetch(`/api/documents/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected: {
            title: editing.title,
            documentType: editing.documentType,
            documentDate: editing.documentDate,
            place: editing.place,
            description: editing.description,
            provenance: editing.provenance,
          },
          next: { title: editTitle.trim(), ...editDetails },
        }),
      });
      const result = (await response.json()) as ListedDocument & { error?: string };
      if (!response.ok) throw new Error(result.error || "Не удалось сохранить документ");
      setEditing(null);
      await load(0);
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : "Не удалось сохранить документ");
    } finally {
      setSavingEdit(false);
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
      if (selected?.id === entry.id) onSelectDocument(null);
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
                setEditing(null);
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
            К кому относится{allowUnlinked ? " · необязательно" : ""}
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
          <DocumentDetailsFields
            value={details}
            onChange={(key, value) => setDetails((current) => ({ ...current, [key]: value }))}
          />
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
              uploading ||
              !file ||
              !title.trim() ||
              (!allowUnlinked && !selectedPeople.length)
            }
          >
            <Upload size={18} />{" "}
            {uploading ? "Загружаем…" : "Добавить документ"}
          </button>
        </form>
      )}
      {editing && (
        <form className="documents-upload documents-edit" aria-label="Редактировать документ" onSubmit={(event) => void saveEdit(event)}>
          <div className="documents-upload-heading">
            <h2>Сведения о документе</h2>
            <button type="button" onClick={() => setEditing(null)} aria-label="Закрыть редактирование">
              <X size={18} />
            </button>
          </div>
          <label className="documents-edit-title">
            Название
            <input value={editTitle} maxLength={160} required onChange={(event) => setEditTitle(event.target.value)} />
          </label>
          <DocumentDetailsFields
            value={editDetails}
            expanded
            onChange={(key, value) => setEditDetails((current) => ({ ...current, [key]: value }))}
          />
          {editError && <p role="alert" className="documents-upload-error">{editError}</p>}
          <div className="documents-edit-actions">
            <button type="submit" className="documents-upload-submit" disabled={savingEdit || !editTitle.trim()}>
              {savingEdit ? "Сохраняем…" : "Сохранить"}
            </button>
            <button type="button" onClick={() => setEditing(null)} disabled={savingEdit}>Отмена</button>
          </div>
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
      {directError && (
        <p className="documents-state" role="alert">
          {directError}
        </p>
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
              : "Загруженные PDF-файлы появятся здесь."}
          </p>
        </div>
      )}
      {!error && !loading && !documents.length && !!query && (
        <p className="documents-state">По запросу ничего не найдено.</p>
      )}
      <div className="documents-groups">
        {deleteError && !activeSelected && (
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
                <div className={`document-item-row ${mayEdit && document.canDelete ? "can-edit" : ""}`} key={document.id}>
                  <button
                    type="button"
                    className="document-item"
                    onClick={() => {
                      setDeleteError("");
                      setAnnotateOnOpen(false);
                      setSelected(document);
                      onSelectDocument(document.id);
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
                      className="document-edit"
                      aria-label={`Редактировать документ «${document.title}»`}
                      title="Редактировать сведения"
                      onClick={() => beginEdit(document)}
                    >
                      <Pencil size={16} />
                    </button>
                  )}
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
      {activeSelected && (
        <PdfBookReader
          document={activeSelected}
          mayAnnotate={mayEdit}
          annotateOnOpen={annotateOnOpen}
          onClose={() => {
            setSelected(null);
            onSelectDocument(null);
          }}
          onEdit={mayEdit && activeSelected.canDelete ? () => beginEdit(activeSelected) : undefined}
          onDelete={
            mayEdit && activeSelected.canDelete
              ? () => void remove(activeSelected)
              : undefined
          }
          deleting={deleting === activeSelected.id}
          deleteError={deleteError}
        />
      )}
    </section>
  );
}
