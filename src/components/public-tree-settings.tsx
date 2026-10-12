import { useState, type FormEvent } from "react";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";

export type PublicTreeSettingsValue = {
  publicTree: boolean;
  publicAlbums: boolean;
  reverseTimeline: boolean;
};

/** The public-access draft lives only while its editor is open. */
export function PublicTreeSettings({
  saved,
  busy,
  notice,
  onSave,
  onDirtyChange,
}: {
  saved: PublicTreeSettingsValue;
  busy: boolean;
  notice: string;
  onSave: (
    draft: PublicTreeSettingsValue,
  ) => Promise<PublicTreeSettingsValue | undefined>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useUnsavedChanges(dirty, onDirtyChange);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const result = await onSave(draft);
    if (result) setDraft(result);
  }
  return (
    <form
      className="admin-card archive-form"
      onSubmit={(event) => void submit(event)}
    >
      <h2>Публичный просмотр</h2>
      <p>
        Откройте всё древо по ссылке для гостей без входа. Публикация отдельных
        людей в общем поиске настраивается отдельно.
      </p>
      <label className="setting-toggle" htmlFor="public-tree">
        <span>
          Всё древо по ссылке
          <small>Все люди, их карточки, семьи и родственные связи</small>
        </span>
        <input
          type="checkbox"
          id="public-tree"
          aria-label="Всё древо по ссылке"
          disabled={busy}
          checked={draft.publicTree}
          onChange={(event) =>
            setDraft({ ...draft, publicTree: event.target.checked })
          }
        />
      </label>
      <label className="setting-toggle" htmlFor="public-albums">
        <span>
          Фотоальбомы<small>Фотографии и описания снимков</small>
        </span>
        <input
          type="checkbox"
          id="public-albums"
          aria-label="Фотоальбомы"
          disabled={busy}
          checked={draft.publicAlbums}
          onChange={(event) =>
            setDraft({ ...draft, publicAlbums: event.target.checked })
          }
        />
      </label>
      <footer>
        <button className="primary-action" disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить настройки"}
        </button>
        <span className="admin-save-state" role="status">
          {dirty ? "Есть несохранённые изменения" : notice}
        </span>
      </footer>
    </form>
  );
}
