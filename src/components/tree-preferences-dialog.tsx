import { useState } from "react";
import {
  ANCESTOR_GENERATIONS,
  DESCENDANT_GENERATIONS,
  COLLATERAL_GENERATIONS,
  fullName,
  type Person,
  type TreePreferences,
} from "../domain";
import { initialFamilyFocus } from "../domain/tree-interactions";
import { familyNeighbors } from "../domain/family-neighborhood";
import { generationScope } from "../domain/tree-generation-scope";
import { EditorDialog } from "./editor-dialog";
import "../styles/tree-preferences.css";

export function TreePreferencesDialog({
  preferences,
  people = [],
  anchorId,
  onChange,
  onClose,
}: {
  preferences: TreePreferences;
  people?: Person[];
  anchorId?: string;
  onChange: (value: TreePreferences) => Promise<TreePreferences>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(preferences);
  const defaultAnchor = people.some((person) => person.id === anchorId)
    ? anchorId!
    : initialFamilyFocus(people)[0];
  const limits = draft.generationLimits;
  const generationOptions = [
    { key: "ancestors", label: "Вверх", values: ANCESTOR_GENERATIONS },
    { key: "descendants", label: "Вниз", values: DESCENDANT_GENERATIONS },
    {
      key: "collateral",
      label: "Боковые ветви",
      values: COLLATERAL_GENERATIONS,
    },
  ] as const;
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
        <fieldset disabled={saving}>
          <legend>Направление</legend>
          <div className="tree-preference-options">
            {[
              { reverse: false, title: "Предки сверху" },
              { reverse: true, title: "Потомки сверху" },
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
        </fieldset>
        {!!people.length && (
          <fieldset disabled={saving} className="tree-generation-settings">
            <legend>Поколения</legend>
            <label className="tree-generation-toggle">
              <input
                type="checkbox"
                checked={!!limits}
                onChange={(event) =>
                  void choose({
                    ...draft,
                    generationLimits: event.target.checked
                      ? {
                          anchorId: defaultAnchor,
                          ancestors: 3,
                          descendants: 3,
                          collateral: 1,
                        }
                      : null,
                  })
                }
              />
              Ограничить видимое древо
            </label>
            {limits && (
              <>
                <p className="tree-generation-count" role="status">
                  В области поколений:{" "}
                  {generationScope(familyNeighbors({ people }), limits).size} из{" "}
                  {people.length} карточек
                </p>
                <label className="tree-generation-anchor">
                  Относительно человека
                  <select
                    value={
                      people.some((person) => person.id === limits.anchorId)
                        ? limits.anchorId
                        : ""
                    }
                    onChange={(event) =>
                      void choose({
                        ...draft,
                        generationLimits: {
                          ...limits,
                          anchorId: event.target.value,
                        },
                      })
                    }
                  >
                    {!people.some(
                      (person) => person.id === limits.anchorId,
                    ) && (
                      <option value="" disabled>
                        Выберите человека
                      </option>
                    )}
                    {[...people]
                      .sort(
                        (a, b) =>
                          fullName(a).localeCompare(fullName(b), "ru") ||
                          a.id.localeCompare(b.id),
                      )
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {fullName(person)}
                        </option>
                      ))}
                  </select>
                </label>
                {generationOptions.map(({ key, label, values }) => (
                  <div className="tree-generation-row" key={key}>
                    <span id={`tree-generation-${key}`}>{label}</span>
                    <div
                      className="tree-preference-options tree-generation-options"
                      role="group"
                      aria-labelledby={`tree-generation-${key}`}
                    >
                      {values.map((value) => (
                        <label
                          key={value}
                          className={limits[key] === value ? "is-selected" : ""}
                        >
                          <input
                            type="radio"
                            name={`tree-generation-${key}`}
                            aria-label={`${label}: ${key === "ancestors" && value === 7 ? "7+" : value}`}
                            checked={limits[key] === value}
                            onChange={() =>
                              void choose({
                                ...draft,
                                generationLimits: { ...limits, [key]: value },
                              })
                            }
                          />
                          <strong>
                            {key === "ancestors" && value === 7 ? "7+" : value}
                          </strong>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="tree-generation-hint">
                  7+ — все предки. Боковые ветви: 0 — прямые линии, 1 — братья,
                  сёстры, дяди и тёти, 2 — также их дети. Супруги сохраняются.
                </p>
              </>
            )}
          </fieldset>
        )}
        <fieldset disabled={saving}>
          <legend>Тема</legend>
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
