import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { GenealogyExportFormat } from "../domain/genealogy-transfer";
import type { TreeExportScope } from "../domain/tree-export-selection";
import { EditorDialog } from "./editor-dialog";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import "../styles/tree-preferences.css";

export function TreeExportDialog({
  onClose,
  onExportPdf,
  canExportArchive = false,
  anchorId,
  anchorName,
}: {
  onClose: () => void;
  onExportPdf: (
    signal: AbortSignal,
    scope: TreeExportScope,
    anchorId?: string,
    generations?: number,
  ) => Promise<void>;
  canExportArchive?: boolean;
  anchorId?: string;
  anchorName?: string;
}) {
  const [scope, setScope] = useState<TreeExportScope>("current");
  const [generations, setGenerations] = useState(5);
  const [format, setFormat] = useState<GenealogyExportFormat>("gedzip7");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const exportPdf = async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setStatus("");
    setError("");
    try {
      await onExportPdf(next.signal, scope, anchorId, generations);
      if (!next.signal.aborted) setStatus("PDF готов.");
    } catch (reason) {
      if (!next.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Не удалось создать PDF.",
        );
    } finally {
      if (!next.signal.aborted) setBusy(false);
    }
  };
  return (
    <EditorDialog
      title="Экспорт древа"
      onClose={onClose}
      className="tree-preferences-dialog"
    >
      <div className="tree-preferences">
        <div className="tree-pdf-export">
          <div className="tree-export-actions">
            <div className="tree-export-options-fields tree-graphic-export">
              <label>
                Область
                <select
                  aria-label="Область экспорта"
                  value={scope}
                  disabled={busy}
                  onChange={(event) =>
                    setScope(event.target.value as TreeExportScope)
                  }
                >
                  <option value="current">Видимое древо · как настроено</option>
                  <option value="all">Всё древо · включая скрытые ветви</option>
                  <option value="family" disabled={!anchorId}>
                    Близкие выбранного
                  </option>
                  <option value="ancestors" disabled={!anchorId}>
                    Предки выбранного
                  </option>
                  <option value="descendants" disabled={!anchorId}>
                    Потомки выбранного
                  </option>
                  <option value="blood" disabled={!anchorId}>
                    Кровные выбранного
                  </option>
                </select>
              </label>
              {(scope === "ancestors" || scope === "descendants") && (
                <label>
                  Поколений
                  <select
                    aria-label="Поколений для экспорта"
                    value={generations}
                    disabled={busy}
                    onChange={(event) =>
                      setGenerations(Number(event.target.value))
                    }
                  >
                    {[2, 3, 4, 5, 6, 7, 8].map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {anchorName && <small>Опорный человек: {anchorName}</small>}
            </div>
            <button
              type="button"
              disabled={
                busy || (scope !== "current" && scope !== "all" && !anchorId)
              }
              onClick={() => void exportPdf()}
            >
              <Download size={16} aria-hidden="true" /> Скачать PDF
            </button>
            {canExportArchive && (
              <div className="tree-genealogy-export">
                <select
                  aria-label="Генеалогический формат"
                  value={format}
                  onChange={(event) =>
                    setFormat(event.target.value as GenealogyExportFormat)
                  }
                >
                  <option value="gedzip7">GEDZIP 7 · с файлами</option>
                  <option value="gedcom7">GEDCOM 7</option>
                  <option value="gedcom551">GEDCOM 5.5.1</option>
                </select>
                <a href={archiveResourceUrl(`/api/gedcom/export?format=${format}`)} download>
                  <Download size={16} aria-hidden="true" /> Скачать
                </a>
              </div>
            )}
          </div>
        </div>
        <p className="tree-preferences-status" role="status">
          {busy ? "Подготавливаем древо…" : status}
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
