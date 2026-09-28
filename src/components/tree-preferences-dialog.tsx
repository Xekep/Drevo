import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { TreePreferences } from "../domain";
import type { GenealogyExportFormat } from "../domain/genealogy-transfer";
import { EditorDialog } from "./editor-dialog";
import "../styles/tree-preferences.css";

export function TreePreferencesDialog({
  preferences,
  canExportArchive = false,
  onChange,
  onClose,
  onExportPdf,
}: {
  preferences: TreePreferences;
  canExportArchive?: boolean;
  onChange: (value: TreePreferences) => Promise<TreePreferences>;
  onClose: () => void;
  onExportPdf: (signal: AbortSignal) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [genealogyFormat, setGenealogyFormat] =
    useState<Exclude<GenealogyExportFormat, "drevoArchive">>("gedzip7");
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => exportController.current?.abort(), []);
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
  const exportTree = async () => {
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExported(false);
    setError("");
    try {
      await onExportPdf(controller.signal);
      if (!controller.signal.aborted) setExported(true);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error &&
            reason.message === "Не удалось дождаться построения древа."
            ? reason.message
            : "Не удалось создать PDF. Попробуйте ещё раз.",
        );
    } finally {
      if (!controller.signal.aborted) setExporting(false);
    }
  };
  return (
    <EditorDialog
      title="Вид древа"
      onClose={onClose}
      className="tree-preferences-dialog"
    >
      <div className="tree-preferences">
        <fieldset disabled={saving || exporting}>
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
        </fieldset>
        <fieldset disabled={saving || exporting}>
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
        <div className="tree-pdf-export">
          <div className="tree-export-actions">
            <button
              type="button"
              aria-label="Сохранить древо в PDF"
              disabled={saving || exporting}
              onClick={() => void exportTree()}
            >
              <Download size={16} aria-hidden="true" />
              Скачать PDF
            </button>
            {canExportArchive && (
              <div className="tree-genealogy-export">
                <select
                  aria-label="Генеалогический формат"
                  value={genealogyFormat}
                  onChange={(event) =>
                    setGenealogyFormat(
                      event.target.value as typeof genealogyFormat,
                    )
                  }
                >
                  <option value="gedzip7">GEDZIP 7 · с файлами</option>
                  <option value="gedcom7">GEDCOM 7</option>
                  <option value="gedcom551">GEDCOM 5.5.1</option>
                </select>
                <a
                  href={`/api/gedcom/export?format=${genealogyFormat}`}
                  download
                >
                  <Download size={16} aria-hidden="true" />
                  Скачать
                </a>
              </div>
            )}
          </div>
        </div>
        <p className="tree-preferences-status" role="status">
          {saving
            ? "Сохраняем…"
            : exporting
              ? "Подготавливаем древо…"
              : exported
                ? "PDF готов."
                : ""}
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
