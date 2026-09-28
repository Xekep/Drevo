import { useState } from "react";
import type { TreePreferences } from "../domain";
import { EditorDialog } from "./editor-dialog";
import "../styles/tree-preferences.css";

export function TreePreferencesDialog({
  preferences,
  linkedPerson,
  onChange,
  onClose,
}: {
  preferences: TreePreferences;
  linkedPerson: boolean;
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
      title="Моё древо"
      onClose={onClose}
      className="tree-preferences-dialog"
    >
      <div className="tree-preferences">
        <p>Эти настройки меняют только ваш просмотр древа.</p>
        <fieldset disabled={saving}>
          <legend>Направление времени</legend>
          <div className="tree-preference-options">
            {[
              {
                reverse: false,
                title: "Предки сверху",
                detail: "От прошлого к настоящему",
              },
              {
                reverse: true,
                title: "Младшие сверху",
                detail: "От настоящего к прошлому",
              },
            ].map(({ reverse, title, detail }) => (
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
                  <small>{detail}</small>
                </span>
              </label>
            ))}
          </div>
          <small>В хронологии время всегда идёт слева направо.</small>
        </fieldset>
        <fieldset disabled={saving}>
          <legend>Цветовая схема</legend>
          <div className="tree-preference-options color-options">
            {([
              { scheme: "warm", title: "Тёплая", detail: "Мягкий светлый фон" },
              { scheme: "white", title: "Белая", detail: "Белый фон древа" },
            ] as const).map(({ scheme, title, detail }) => (
              <label
                key={scheme}
                className={draft.colorScheme === scheme ? "is-selected" : ""}
              >
                <input
                  type="radio"
                  name="tree-color-scheme"
                  aria-label={title}
                  checked={draft.colorScheme === scheme}
                  onChange={() => void choose({ ...draft, colorScheme: scheme })}
                />
                <span
                  className={`tree-color-preview ${scheme}-preview`}
                  aria-hidden="true"
                >
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={saving}>
          <legend>Вид карточки</legend>
          <div className="tree-preference-options card-options">
            <label
              className={draft.cardVariant === "classic" ? "is-selected" : ""}
            >
              <input
                type="radio"
                name="tree-card"
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
            <label
              className={draft.cardVariant === "portrait" ? "is-selected" : ""}
            >
              <input
                type="radio"
                name="tree-card"
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
          </div>
          {!linkedPerson && (
            <small>
              Для подписи родства аккаунт должен быть привязан к человеку в
              древе.
            </small>
          )}
        </fieldset>
        {saving && <p role="status">Сохраняем…</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </EditorDialog>
  );
}
