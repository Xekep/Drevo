import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Maximize2 } from "lucide-react";
import { PersonDetailDialog } from "./person-detail-dialog";
import { confirmDiscardChanges } from "../hooks/useUnsavedChanges";
import { BiographyEditor } from "./biography-editor";

type LifeDraft = { occupation: string; biography: string };

/** The expanded section applies both fields to the person form in one change. */
export function PersonLifeEditor({
  occupation,
  biography,
  onChange,
  onEditingChange,
  children,
}: LifeDraft & {
  onChange: (value: LifeDraft) => void;
  onEditingChange: (dirty: boolean) => void;
  children?: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const [inlineMapDirty, setInlineMapDirty] = useState(false),
    [expandedMapDirty, setExpandedMapDirty] = useState(false);
  const [editing, setEditing] = useState<{
    baseline: LifeDraft;
    value: LifeDraft;
  } | null>(null);
  const dirty =
    !!editing &&
    (editing.value.occupation !== editing.baseline.occupation ||
      editing.value.biography !== editing.baseline.biography);
  useEffect(() => {
    onEditingChange(dirty || inlineMapDirty || expandedMapDirty);
  }, [dirty, inlineMapDirty, expandedMapDirty, onEditingChange]);
  useEffect(() => () => onEditingChange(false), [onEditingChange]);
  return (
    <>
      <details
        className="form-details person-life-editor"
        onToggle={(event) => setOpened(event.currentTarget.open)}
      >
        <summary>
          <BookOpen size={17} aria-hidden="true" />
          <span>Жизнь и занятия</span>
          <button
            type="button"
            className="person-life-expand"
            aria-label="Открыть жизнь и занятия в отдельном окне"
            title="Открыть в отдельном окне"
            aria-haspopup="dialog"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const value = { occupation, biography };
              setEditing({ baseline: value, value });
            }}
          >
            <Maximize2 size={14} aria-hidden="true" />
          </button>
        </summary>
        {children}
        {opened && (
          <div className="person-life-history">
            <span>История человека</span>
            <BiographyEditor
              value={biography}
              onDirtyChange={setInlineMapDirty}
              onChange={(value) => onChange({ occupation, biography: value })}
            />
          </div>
        )}
      </details>
      {editing && (
        <PersonDetailDialog
          title="Жизнь и занятия"
          dirty={dirty || expandedMapDirty}
          className="person-life-dialog"
          onClose={() => {
            if (confirmDiscardChanges(dirty || expandedMapDirty))
              setEditing(null);
          }}
          onApply={() => {
            onChange(editing.value);
            setEditing(null);
          }}
        >
          <label>
            Занятие
            <input
              value={editing.value.occupation}
              onChange={(event) =>
                setEditing({
                  ...editing,
                  value: { ...editing.value, occupation: event.target.value },
                })
              }
            />
          </label>
          <div className="person-life-history">
            <span>История человека</span>
            <BiographyEditor
              value={editing.value.biography}
              onDirtyChange={setExpandedMapDirty}
              onChange={(biography) =>
                setEditing({
                  ...editing,
                  value: { ...editing.value, biography },
                })
              }
            />
          </div>
        </PersonDetailDialog>
      )}
    </>
  );
}
