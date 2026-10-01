import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { GenealogyExportFormat } from "../domain/genealogy-transfer";
import { EditorDialog } from "./editor-dialog";
import "../styles/tree-preferences.css";

type ExportFormat = "pdf" | "generation-text" | GenealogyExportFormat;

export function TreeExportDialog({
  onClose,
  onExportPdf,
  onExportText,
  onExportGenealogy,
}: {
  onClose: () => void;
  onExportPdf: (signal: AbortSignal) => Promise<void>;
  onExportText: (signal: AbortSignal) => Promise<void>;
  onExportGenealogy?: (format: GenealogyExportFormat, signal: AbortSignal, onError: (message: string) => void) => Promise<void>;
}) {
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const exportTree = async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setStatus("");
    setError("");
    try {
      if (format === "pdf") await onExportPdf(next.signal);
      else if (format === "generation-text") await onExportText(next.signal);
      else await onExportGenealogy?.(format, next.signal, setError);
      if (!next.signal.aborted)
        setStatus(format === "pdf" ? "PDF готов." : "Скачивание началось.");
    } catch (reason) {
      if (!next.signal.aborted)
        setError(reason instanceof Error ? reason.message : "Не удалось экспортировать древо.");
    } finally {
      if (!next.signal.aborted) setBusy(false);
    }
  };

  return (
    <EditorDialog title="Экспорт древа" onClose={onClose} className="tree-preferences-dialog">
      <div className="tree-preferences">
        <div className="tree-pdf-export">
          <p>Экспортируется видимое древо с текущими настройками и раскрытыми ветвями.</p>
          <div className="tree-genealogy-export">
            <select
              aria-label="Формат экспорта"
              value={format}
              disabled={busy}
              onChange={(event) => setFormat(event.target.value as ExportFormat)}
            >
              <option value="pdf">PDF</option>
              <option value="generation-text">Поколенная роспись · TXT</option>
              {onExportGenealogy && <>
                <option value="gedzip7">GEDZIP 7 · с файлами</option>
                <option value="gedcom7">GEDCOM 7</option>
                <option value="gedcom551">GEDCOM 5.5.1</option>
              </>}
            </select>
            <button type="button" disabled={busy} onClick={() => void exportTree()}>
              <Download size={16} aria-hidden="true" /> Скачать
            </button>
          </div>
        </div>
        <p className="tree-preferences-status" role="status">
          {busy ? "Подготавливаем древо…" : status}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </EditorDialog>
  );
}
