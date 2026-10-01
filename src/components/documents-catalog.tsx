import { documentFileTypeFromName } from "../shared/document-file.ts";
import { archiveFetch } from "../data/archive-fetch.ts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BookOpenText,
  Image as ImageIcon,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import {
  DocumentPeoplePicker,
  type DocumentPerson,
} from "./document-people-picker";
import { PdfBookReader } from "./pdf-book-reader";
import { DocumentDetailsFields } from "./document-details-fields";
import { DocumentRelationsFields } from "./document-relations-fields";
import { fullName, type Person } from "../domain";
import type { DocumentDetails } from "../shared/document-details";
import type { DocumentEventLink, DocumentPage } from "../shared/document-links";
import "../styles/documents.css";

export type ListedDocument = DocumentDetails & {
  id: string;
  title: string;
  url: string;
  size: number;
  mimeType?: string;
  createdAt: string;
  canDelete?: boolean;
  people: Array<{ id: string; name: string }>;
  eventLinks: Array<DocumentEventLink & { personName: string; eventTitle: string }>;
  pages: DocumentPage[];
  sources: Array<{ personId: string; personName: string; eventId?: string; eventTitle?: string; title: string; reference: string; page?: number }>;
};

type DocumentCatalogPage = { items: ListedDocument[]; total: number };
const PAGE_SIZE = 30;
const documentSize = (bytes: number) => bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`
  : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
const documentFormat = (mimeType?: string) => mimeType?.startsWith("image/")
  ? mimeType.slice(6).replace("jpeg", "jpg").toUpperCase()
  : "PDF";
const EMPTY_DETAILS: DocumentDetails = {
  documentType: "",
  documentDate: "",
  place: "",
  description: "",
  provenance: "",
};

export function DocumentsCatalog({
  mayEdit,
  allowUnlinked,
  personFilter,
  documentId,
  documentPage,
  onSelectDocument,
  people,
}: {
  mayEdit: boolean;
  allowUnlinked: boolean;
  personFilter: string | null;
  documentId: string | null;
  documentPage?: number;
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
  const [editDetails, setEditDetails] =
    useState<DocumentDetails>(EMPTY_DETAILS);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const [selectedPeople, setSelectedPeople] = useState<DocumentPerson[]>([]);
  const [editPeople, setEditPeople] = useState<DocumentPerson[]>([]);
  const [eventLinks, setEventLinks] = useState<DocumentEventLink[]>([]);
  const [pages, setPages] = useState<DocumentPage[]>([]);
  const [editEvents, setEditEvents] = useState<DocumentEventLink[]>([]);
  const [editPages, setEditPages] = useState<DocumentPage[]>([]);
  const [dragging, setDragging] = useState(false);
  const filteredPerson = people.find((person) => person.id === personFilter);

  const chooseFile = useCallback(
    (next: File) => {
      setUploadOpen(true);
      setEditing(null);
      setUploadError("");
      const type = documentFileTypeFromName(next.name);
      if (
        !type ||
        (next.type && ![type.mime, "application/octet-stream", ...(type.extension === "tif" ? ["image/x-tiff"] : [])].includes(next.type))
      ) {
        setUploadError("Поддерживаются PDF, TIFF, JPEG, PNG, WebP и GIF");
        setFile(null);
        return;
      }
      if (next.size > type.maxBytes) {
        setUploadError(["pdf", "tif"].includes(type.extension)
          ? "PDF или TIFF должен быть не больше 50 МБ"
          : "Изображение должно быть не больше 20 МБ");
        setFile(null);
        return;
      }
      setFile(next);
      setTitle(next.name.replace(/\.[a-z]+$/i, "").slice(0, 160));
      setEventLinks([]);
      setPages([]);
      if (filteredPerson)
        setSelectedPeople([
          { id: filteredPerson.id, name: fullName(filteredPerson) },
        ]);
    },
    [filteredPerson],
  );

  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      event.dataTransfer?.types.includes("Files");
    const unavailable = () =>
      !mayEdit || uploading || !!document.querySelector("dialog[open]");
    const reset = () => setDragging(false);
    const over = (event: DragEvent) => {
      if (
        !hasFiles(event) ||
        event.defaultPrevented ||
        document.querySelector("dialog[open]")
      )
        return;
      event.preventDefault();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = unavailable() ? "none" : "copy";
      if (!unavailable()) setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight
      )
        reset();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      const handled = event.defaultPrevented;
      event.preventDefault();
      reset();
      if (handled || unavailable()) return;
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      if (files.length !== 1) {
        setUploadOpen(true);
        setUploadError("Перетащите один документ за раз");
        return;
      }
      chooseFile(files[0]);
    };
    window.addEventListener("dragenter", over);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", over);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [mayEdit, uploading, chooseFile]);

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
        const response = await archiveFetch(
          `/api/documents?offset=${offset}&limit=${PAGE_SIZE}&q=${encodeURIComponent(query.trim())}${personFilter !== null ? `&personId=${encodeURIComponent(personFilter)}` : ""}`,
          { signal: request.signal },
        );
        if (!response.ok) throw new Error("Не удалось загрузить документы");
      const page = (await response.json()) as DocumentCatalogPage;
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
        const response = await archiveFetch(`/api/documents/${documentId}`, {
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

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || !title.trim() || (!allowUnlinked && !selectedPeople.length))
      return;
    const type = documentFileTypeFromName(file.name);
    if (!type) return;
    setUploading(true);
    setUploadError("");
    try {
      const metadata = JSON.stringify({
        title: title.trim(),
        personIds: selectedPeople.map((person) => person.id),
        eventLinks,
        pages,
        ...details,
      });
      const response = await archiveFetch("/api/documents", {
        method: "POST",
        headers: {
          "Content-Type": type.mime,
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
        mimeType: type.mime,
        createdAt: new Date().toISOString(),
        canDelete: true,
        people: selectedPeople.map((person) => ({
          id: person.id,
          name: person.name,
        })),
        eventLinks: eventLinks.map((link) => {
          const person = people.find((item) => item.id === link.personId);
          const event = person?.events?.find((item) => item.id === link.eventId);
          return { ...link, personName: person ? fullName(person) : "", eventTitle: event?.title || event?.type || "" };
        }),
        pages,
        sources: [],
      });
      onSelectDocument(created.id);
      setUploadOpen(false);
      setFile(null);
      setTitle("");
      setDetails(EMPTY_DETAILS);
      setSelectedPeople([]);
      setEventLinks([]);
      setPages([]);
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
    setEditPeople(entry.people);
    setEditEvents(entry.eventLinks.map(({ personId, eventId, page }) => ({ personId, eventId, ...(page ? { page } : {}) })));
    setEditPages(entry.pages);
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
      const response = await archiveFetch(`/api/documents/${editing.id}`, {
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
          people: {
            expected: editing.people.map((p) => p.id),
            next: editPeople.map((p) => p.id),
          },
          eventLinks: {
            expected: editing.eventLinks,
            next: editEvents,
          },
          pages: { expected: editing.pages, next: editPages },
        }),
      });
      const result = (await response.json()) as ListedDocument & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error || "Не удалось сохранить документ");
      setEditing(null);
      await load(0);
    } catch (reason) {
      setEditError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить документ",
      );
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
        `Удалить документ «${entry.title}»? Файл и его привязки к людям будут удалены из архива.`,
      )
    )
      return;
    setDeleting(entry.id);
    setDeleteError("");
    try {
      const response = await archiveFetch(`/api/documents/${entry.id}`, {
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
      {dragging &&
        createPortal(
          <div className="documents-drop-overlay" role="status">
            <Upload size={48} strokeWidth={1.4} aria-hidden="true" />
            <b>Перетащите документ сюда</b>
            <span>PDF до 50 МБ или изображение до 20 МБ</span>
          </div>,
          document.body,
        )}
      <header className="documents-heading">
        <div>
          <span className="documents-eyebrow">Семейный архив</span>
          <h1>Документы</h1>
          <p>
            {personFilter !== null
              ? `Документы, связанные с ${filteredPerson ? fullName(filteredPerson) : "выбранным человеком"}.`
              : "Загруженные участниками документы, связанные с людьми в архиве."}
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
                      name: fullName(filteredPerson),
                    },
                  ]);
                setUploadOpen((open) => !open);
              }}
              aria-expanded={uploadOpen}
            >
              <Plus size={18} /> Добавить документ
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
          <label className="documents-drop-zone">
            <span className="documents-drop-icon"><Upload size={26} aria-hidden="true" /></span>
            <strong>
              {file ? file.name : "Перетащите документ сюда"}
            </strong>
            <span>PDF до 50 МБ, изображение до 20 МБ · людей можно привязать позже</span>
            <span className="documents-file-picker">
              {file ? "Выбрать другой файл" : "Выбрать файл"}
            </span>
            <input
              type="file"
              accept=".pdf,.tif,.tiff,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/tiff,image/x-tiff,image/jpeg,image/png,image/webp,image/gif"
              disabled={uploading}
              aria-label="Файл документа"
              onChange={(event) => {
                const next = event.target.files?.[0];
                if (next) chooseFile(next);
                event.target.value = "";
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
          <DocumentPeoplePicker
            value={selectedPeople}
            onChange={(next) => {
              setSelectedPeople(next);
              setEventLinks((current) => current.filter((link) => next.some((person) => person.id === link.personId)));
            }}
            optional={allowUnlinked}
            disabled={uploading}
          />
          <DocumentDetailsFields
            value={details}
            onChange={(key, value) =>
              setDetails((current) => ({ ...current, [key]: value }))
            }
          />
          <DocumentRelationsFields people={people} personIds={selectedPeople.map((person) => person.id)}
            eventLinks={eventLinks} pages={pages} onEventsChange={setEventLinks} onPagesChange={setPages} disabled={uploading} />
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
        <form
          className="documents-upload documents-edit"
          aria-label="Редактировать документ"
          onSubmit={(event) => void saveEdit(event)}
        >
          <div className="documents-upload-heading">
            <h2>Сведения о документе</h2>
            <button
              type="button"
              onClick={() => setEditing(null)}
              aria-label="Закрыть редактирование"
            >
              <X size={18} />
            </button>
          </div>
          <label className="documents-edit-title">
            Название
            <input
              value={editTitle}
              maxLength={160}
              required
              onChange={(event) => setEditTitle(event.target.value)}
            />
          </label>
          <DocumentPeoplePicker
            value={editPeople}
            onChange={(next) => {
              setEditPeople(next);
              setEditEvents((current) => current.filter((link) => next.some((person) => person.id === link.personId)));
            }}
            disabled={savingEdit}
          />
          <DocumentDetailsFields
            value={editDetails}
            expanded
            onChange={(key, value) =>
              setEditDetails((current) => ({ ...current, [key]: value }))
            }
          />
          <DocumentRelationsFields people={people} personIds={editPeople.map((person) => person.id)}
            eventLinks={editEvents} pages={editPages} onEventsChange={setEditEvents} onPagesChange={setEditPages} disabled={savingEdit} />
          {editError && (
            <p role="alert" className="documents-upload-error">
              {editError}
            </p>
          )}
          <div className="documents-edit-actions">
            <button
              type="submit"
              className="documents-upload-submit"
              disabled={savingEdit || !editTitle.trim()}
            >
              {savingEdit ? "Сохраняем…" : "Сохранить"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              disabled={savingEdit}
            >
              Отмена
            </button>
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
              ? "К этому человеку пока не привязан ни один документ."
              : "Загруженные документы появятся здесь."}
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
                <div
                  className={`document-item-row ${mayEdit && document.canDelete ? "can-edit" : ""}`}
                  key={document.id}
                >
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
                      {document.mimeType?.startsWith("image/")
                        ? <ImageIcon size={25} strokeWidth={1.5} />
                        : <BookOpenText size={25} strokeWidth={1.5} />}
                    </span>
                    <span className="document-item-text">
                      <strong>{document.title}</strong>
                      <small>
                        <span className="document-format">
                          {documentFormat(document.mimeType)}
                        </span>
                        <span>{document.documentType || documentSize(document.size)}</span>
                        {document.documentDate && <span>· {document.documentDate}</span>}
                      </small>
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
          key={activeSelected.id}
          document={activeSelected}
          initialPage={documentPage}
          mayAnnotate={mayEdit}
          annotateOnOpen={annotateOnOpen}
          onClose={() => {
            setSelected(null);
            onSelectDocument(null);
          }}
          onEdit={
            mayEdit && activeSelected.canDelete
              ? () => beginEdit(activeSelected)
              : undefined
          }
        />
      )}
    </section>
  );
}
