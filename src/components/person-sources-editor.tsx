import { useState } from "react";
import { BookOpen, Files, Trash2 } from "lucide-react";
import type { Source } from "../domain/types";
import { safeUrl } from "../domain/dates";
import { validPersonSource } from "../domain/validation";
import {
  archiveResourceUrl,
  scopedArchivePath,
} from "../domain/archive-context";
import { archiveDocumentPath } from "../domain/archive-routes";
import { sourceCitation } from "../shared/source-catalog";
import { CatalogPicker } from "./union-sources-editor";
import { SourceRepositoryEditor } from "./source-repository-editor";
import { DocumentSourcePicker } from "./document-source-picker";
import { PersonDocumentsEditor } from "./person-documents-editor";
import { PersonDetailDialog } from "./person-detail-dialog";

export function PersonSourcesEditor({
  sources,
  onChange,
  personId,
  isAdmin,
  busy,
  onEditingChange,
}: {
  sources: Source[];
  onChange: (sources: Source[]) => void;
  personId?: string;
  isAdmin: boolean;
  busy: boolean;
  onEditingChange?: (dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState<{
    index: number;
    source: Source;
  } | null>(null);
  const shown =
    editing && editing.index === sources.length
      ? [...sources, editing.source]
      : sources;
  const update = (source: Source) =>
    setEditing((old) => old && { ...old, source });
  const close = () => setEditing(null);
  const apply = () => {
    if (!editing) return;
    const source = { ...editing.source, title: editing.source.title.trim() };
    if (!source.title || !validPersonSource(source))
      throw new Error("Укажите название и проверьте данные источника.");
    onChange(
      editing.index === sources.length
        ? [...sources, source]
        : sources.map((item, index) =>
            index === editing.index ? source : item,
          ),
    );
    close();
  };
  return (
    <details className="form-details person-sources-editor">
      <summary>
        <Files size={17} aria-hidden="true" />
        Источники
      </summary>
      <section>
        <p className="field-hint">Общие источники о человеке.</p>
        {shown.map((stored, index) => {
          const s = editing?.index === index ? editing.source : stored;
          return (
            <details
              className="source-editor"
              key={index}
              open={editing?.index === index}
            >
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  setEditing({ index, source: structuredClone(stored) });
                }}
              >
                <BookOpen size={15} aria-hidden="true" />
                <span>
                  {s.title || "Новый источник"}
                  {s.reference && <small>{s.reference}</small>}
                </span>
              </summary>
              {editing?.index === index && (
                <PersonDetailDialog
                  title="Источник"
                  dirty={JSON.stringify(editing.source) !== JSON.stringify(sources[editing.index]
                    || { title: "", type: "", reference: "" })}
                  onDirtyChange={onEditingChange}
                  onClose={close}
                  onApply={apply}
                >
                  <div className="person-source-fields">
                    {s.catalogId ? (
                      <div className="source-catalog-citation">
                        <small>
                          Источник из каталога{s.type ? ` · ${s.type}` : ""}
                        </small>
                        <strong>{s.title}</strong>
                        {s.reference && <span>{s.reference}</span>}
                        {s.note && <span>{s.note}</span>}
                        {safeUrl(s.url) && (
                          <a
                            href={archiveResourceUrl(safeUrl(s.url) || "")}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Открыть источник
                          </a>
                        )}
                        {s.documentId && (
                          <a
                            href={scopedArchivePath(
                              archiveDocumentPath(
                                null,
                                s.documentId,
                                s.documentPage,
                              ),
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Открыть документ
                            {s.documentPage ? ` · стр. ${s.documentPage}` : ""}
                          </a>
                        )}
                      </div>
                    ) : (
                      <>
                        <SourceRepositoryEditor source={s} onChange={update} />
                        {(
                          [
                            ["title", "Название"],
                            ["type", "Тип документа"],
                            ["reference", "Архивный шифр"],
                            ["url", "Ссылка"],
                            ["note", "Примечание"],
                          ] as const
                        ).map(([key, label]) => (
                          <label key={key} className={`person-source-${key}`}>
                            {label}
                            {key === "note" ? (
                              <textarea
                                rows={2}
                                value={s.note || ""}
                                maxLength={10000}
                                onChange={(event) =>
                                  update({ ...s, note: event.target.value })
                                }
                              />
                            ) : (
                              <input
                                inputMode={key === "url" ? "url" : undefined}
                                value={s[key] || ""}
                                required={key === "title"}
                                maxLength={2000}
                                onChange={(event) =>
                                  update({ ...s, [key]: event.target.value })
                                }
                              />
                            )}
                          </label>
                        ))}
                        <DocumentSourcePicker
                          personId={personId}
                          documentId={s.documentId}
                          pageNumber={s.documentPage}
                          onChange={(document) =>
                            update({
                              ...s,
                              title: s.title || document?.title || "",
                              documentId: document?.id,
                              documentPage:
                                document?.id === s.documentId
                                  ? s.documentPage
                                  : undefined,
                            })
                          }
                          onPageChange={(documentPage) =>
                            update({ ...s, documentPage })
                          }
                        />
                      </>
                    )}
                    {index < sources.length && (
                      <button
                        type="button"
                        className="source-remove"
                        aria-label={`Убрать источник ${index + 1}`}
                        onClick={() => {
                          onChange(sources.filter((_, i) => i !== index));
                          close();
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                        Убрать источник
                      </button>
                    )}
                  </div>
                </PersonDetailDialog>
              )}
            </details>
          );
        })}
        <button
          type="button"
          disabled={sources.length >= 50 || busy}
          onClick={() =>
            setEditing({
              index: sources.length,
              source: { title: "", type: "", reference: "" },
            })
          }
        >
          + Источник
        </button>
        {isAdmin && sources.length < 50 && (
          <CatalogPicker
            existing={sources}
            onChoose={(entry) =>
              setEditing({
                index: sources.length,
                source: sourceCitation(entry),
              })
            }
          />
        )}
      </section>
      <PersonDocumentsEditor personId={personId} disabled={busy} />
    </details>
  );
}
