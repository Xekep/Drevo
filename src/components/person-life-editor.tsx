import { useId, useState, type ReactNode } from "react";
import { BookOpen, Maximize2 } from "lucide-react";
import { PersonDetailDialog } from "./person-detail-dialog";
import { confirmDiscardChanges } from "../hooks/useUnsavedChanges";

type LifeDraft = { occupation: string; biography: string };

/** The expanded section applies both fields to the person form in one change. */
export function PersonLifeEditor({ occupation, biography, onChange, onEditingChange, children }: LifeDraft & {
  onChange: (value: LifeDraft) => void;
  onEditingChange: (dirty: boolean) => void;
  children?: ReactNode;
}) {
  const fieldId = useId();
  const [editing, setEditing] = useState<{ baseline: LifeDraft; value: LifeDraft } | null>(null);
  const dirty = !!editing && (editing.value.occupation !== editing.baseline.occupation ||
    editing.value.biography !== editing.baseline.biography);
  return (
    <>
    <details className="form-details person-life-editor">
      <summary>
        <BookOpen size={17} aria-hidden="true" />
        <span>Жизнь и занятия</span>
        <button type="button" className="person-life-expand"
          aria-label="Открыть жизнь и занятия в отдельном окне"
          title="Открыть в отдельном окне" aria-haspopup="dialog"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const value = { occupation, biography };
            setEditing({ baseline: value, value });
          }}>
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </summary>
      {children}
      <label htmlFor={fieldId}>История человека
        <textarea id={fieldId} rows={4} value={biography}
          onChange={(event) => onChange({ occupation, biography: event.target.value })} />
      </label>
    </details>
      {editing && <PersonDetailDialog title="Жизнь и занятия" dirty={dirty}
        className="person-life-dialog"
        onDirtyChange={onEditingChange}
        onClose={() => { if (confirmDiscardChanges(dirty)) setEditing(null); }}
        onApply={() => { onChange(editing.value); setEditing(null); }}>
        <label>Занятие
          <input value={editing.value.occupation}
            onChange={(event) => setEditing({ ...editing, value: { ...editing.value, occupation: event.target.value } })} />
        </label>
        <label>История человека
          <textarea rows={14} className="person-life-expanded-history" value={editing.value.biography}
            onChange={(event) => setEditing({ ...editing, value: { ...editing.value, biography: event.target.value } })} />
        </label>
      </PersonDetailDialog>}
    </>
  );
}
