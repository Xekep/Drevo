import { useState } from "react";
import type { Family } from "../domain";
import { EditorDialog } from "./editor-dialog";
export function ArchiveSettings({
  family,
  save,
  busy,
  onClose,
}: {
  family: Family;
  save: (f: Family) => Promise<Family>;
  busy: boolean;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(family.title),
    [description, setDescription] = useState(family.description),
    [error, setError] = useState("");
  async function persist(data: Family) {
    try {
      await save(data);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <EditorDialog title="Настройки архива" onClose={onClose}>
      <form
        className="archive-form"
        onSubmit={(e) => {
          e.preventDefault();
          void persist({ ...family, title, description });
        }}
      >
        <label>
          Название
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Описание
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <button disabled={busy} className="primary-action">
          Сохранить настройки
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </EditorDialog>
  );
}
