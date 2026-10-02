import { useState } from "react";
import type { Source } from "../domain/types.ts";
import "../styles/source-repository-editor.css";

const emptyRepository: NonNullable<Source["repository"]> = {
  name: "",
  callNumber: "",
  website: "",
  note: "",
  linkNote: "",
};

/** Edits an inline source's GEDCOM repository without touching its citation PAGE or URL. */
export function SourceRepositoryEditor({
  source,
  onChange,
}: {
  source: Source;
  onChange: (source: Source) => void;
}) {
  const [open, setOpen] = useState(!source.repository?.name);
  if (source.catalogId) return null;
  const repository = source.repository;
  const update = (
    field: keyof NonNullable<Source["repository"]>,
    value: string,
  ) => {
    if (!repository) return;
    onChange({ ...source, repository: { ...repository, [field]: value } });
  };

  if (!repository)
    return (
      <button
        type="button"
        className="source-repository-add"
        onClick={() => {
          setOpen(true);
          onChange({ ...source, repository: { ...emptyRepository } });
        }}
      >
        Добавить хранилище источника
      </button>
    );

  return (
    <details
      className="source-repository-editor"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        onClick={(event) => {
          if (!repository.name.trim()) event.preventDefault();
        }}
      >
        Хранилище{repository.name ? ` · ${repository.name}` : ""}
      </summary>
      <div className="source-repository-fields">
        <label>
          Название хранилища (NAME)
          <input
            required
            aria-invalid={!repository.name.trim()}
            maxLength={10000}
            value={repository.name}
            onChange={(event) => update("name", event.target.value)}
          />
        </label>
        {!repository.name.trim() && (
          <small role="alert">
            Укажите название хранилища перед сохранением.
          </small>
        )}
        <label>
          Шифр хранилища (CALN)
          <input
            maxLength={10000}
            value={repository.callNumber}
            onChange={(event) => update("callNumber", event.target.value)}
          />
        </label>
        <label>
          Сайт хранилища (WWW)
          <input
            inputMode="url"
            maxLength={10000}
            value={repository.website}
            onChange={(event) => update("website", event.target.value)}
          />
        </label>
        <label>
          Примечание хранилища
          <textarea
            rows={2}
            maxLength={10000}
            value={repository.note}
            onChange={(event) => update("note", event.target.value)}
          />
        </label>
        <label>
          Примечание о хранении (REPO.NOTE)
          <textarea
            rows={2}
            maxLength={10000}
            value={repository.linkNote}
            onChange={(event) => update("linkNote", event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            const next = { ...source };
            delete next.repository;
            onChange(next);
          }}
        >
          Убрать сведения о хранилище
        </button>
      </div>
    </details>
  );
}
