import { useState } from "react";
import type { TreePreferences } from "../domain";
import { EditorDialog } from "./editor-dialog";
import "../styles/tree-preferences.css";

export function TreePreferencesDialog({
  preferences,
  linkedPerson,
  localOnly = false,
  onChange,
  onClose,
}: {
  preferences: TreePreferences;
  linkedPerson: boolean;
  localOnly?: boolean;
  onChange: (value: TreePreferences) => Promise<TreePreferences>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(preferences);
  const choose = async (value: TreePreferences) => {
    setDraft(value);
    setSaving(true);
    setError("");
    try {
      setDraft(await onChange(value));
    } catch (reason) {
      setDraft(preferences);
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <EditorDialog
      title="Вид древа"
      onClose={onClose}
      className="tree-preferences-dialog"
    >
      <div className="tree-preferences">
        <p>
          {localOnly
            ? "Ваш вид · сохраняется в этом браузере"
            : "Ваш вид · сохраняется в аккаунте"}
        </p>
        <fieldset disabled={saving}>
          <legend>Поколения</legend>
          <div className="tree-preference-options">
            {[
              {
                reverse: false,
                title: "Предки сверху",
              },
              {
                reverse: true,
                title: "Младшие сверху",
              },
            ].map(({ reverse, title }) => (
              <label
                key={title}
                className={
                  draft.reverseTimeline === reverse ? "is-selected" : ""
                }
              >
                <input
                  type="radio"
                  name="tree-direction"
                  aria-label={title}
                  checked={draft.reverseTimeline === reverse}
                  onChange={() =>
                    void choose({ ...draft, reverseTimeline: reverse })
                  }
                />
                <span>
                  <strong>{title}</strong>
                </span>
              </label>
            ))}
          </div>
          <small>В хронологии время идёт слева направо.</small>
        </fieldset>
        <fieldset disabled={saving}>
          <legend>Фон</legend>
          <div className="tree-preference-options color-options">
            {(
              [
                { scheme: "warm", title: "Тёплая" },
                { scheme: "white", title: "Белая" },
              ] as const
            ).map(({ scheme, title }) => (
              <label
                key={scheme}
                className={draft.colorScheme === scheme ? "is-selected" : ""}
              >
                <input
                  type="radio"
                  name="tree-color-scheme"
                  aria-label={title}
                  checked={draft.colorScheme === scheme}
                  onChange={() =>
                    void choose({ ...draft, colorScheme: scheme })
                  }
                />
                <span
                  className={`tree-color-preview ${scheme}-preview`}
                  aria-hidden="true"
                />
                <span>
                  <strong>{title}</strong>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={saving}>
          <legend>Карточки</legend>
          <div className="tree-preference-options card-options">
            <label
              className={draft.cardVariant === "portrait" ? "is-selected" : ""}
            >
              <input
                type="radio"
                name="tree-card"
                aria-label="Фото · ФИО · Родство"
                checked={draft.cardVariant === "portrait"}
                onChange={() =>
                  void choose({ ...draft, cardVariant: "portrait" })
                }
              />
              <span
                className="tree-card-preview stacked-preview"
                aria-hidden="true"
              >
                <i>А</i>
                <b>Иванова Анна Петровна</b>
                <small>1988–2024</small>
                <small>Двоюродная сестра</small>
              </span>
              <strong>Фото · ФИО · Родство</strong>
            </label>
            <label
              className={draft.cardVariant === "classic" ? "is-selected" : ""}
            >
              <input
                type="radio"
                name="tree-card"
                aria-label="Обычная"
                checked={draft.cardVariant === "classic"}
                onChange={() =>
                  void choose({ ...draft, cardVariant: "classic" })
                }
              />
              <span
                className="tree-card-preview classic-preview"
                aria-hidden="true"
              >
                <i>А</i>
                <span>
                  <b>Иванова</b>
                  <small>Анна Петровна</small>
                  <small>1988–2024</small>
                </span>
              </span>
              <strong>Обычная</strong>
            </label>
          </div>
          {!linkedPerson && (
            <small>Родство появится после привязки аккаунта к человеку.</small>
          )}
        </fieldset>
        <p className="tree-preferences-status" role="status">
          {saving ? "Сохраняем…" : ""}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </EditorDialog>
  );
}
