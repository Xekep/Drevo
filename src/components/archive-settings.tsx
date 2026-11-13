import { useState } from "react";
import type { Family } from "../domain";
import { EditorDialog } from "./editor-dialog";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";
export function ArchiveSettingsForm({
  family,
  save,
  busy,
  onSaved,
  onDirtyChange,
}: {
  family: Family;
  save: (f: Family) => Promise<Family>;
  busy: boolean;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [title, setTitle] = useState(family.title),
    [description, setDescription] = useState(family.description),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [notice, setNotice] = useState("");
  useUnsavedChanges(title !== family.title || description !== family.description, onDirtyChange);
  async function persist(data: Family) {
    if (busy || saving) return;
    if (!data.title.trim()) { setError("Укажите название древа"); return; }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const saved = await save({ ...data, title: data.title.trim(), description: data.description.trim() });
      setTitle(saved.title);
      setDescription(saved.description);
      setNotice("Настройки сохранены.");
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally { setSaving(false); }
  }
  return (
      <form
        className="archive-form"
        onSubmit={(e) => {
          e.preventDefault();
          void persist({ ...family, title, description });
        }}
      >
        <label>
          Название древа
          <input
            required
            maxLength={160}
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
        <button disabled={busy || saving} className="primary-action">
          {saving ? "Сохраняем…" : "Сохранить настройки"}
        </button>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
  );
}

export function ArchiveSettings({ family, save, busy, onClose }: {
  family: Family; save: (f: Family) => Promise<Family>; busy: boolean; onClose: () => void;
}) {
  return <EditorDialog title="Настройки архива" onClose={onClose}>
    <ArchiveSettingsForm family={family} save={save} busy={busy} onSaved={onClose} />
  </EditorDialog>;
}
