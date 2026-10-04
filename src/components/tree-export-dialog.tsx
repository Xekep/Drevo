import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { GenealogyExportFormat } from "../domain/genealogy-transfer";
import { EditorDialog } from "./editor-dialog";
import "../styles/tree-preferences.css";

type ExportFormat = "pdf" | "generation-text" | GenealogyExportFormat;
const noParentEvidence = async () => false;

export function TreeExportDialog({
  onClose,
  onExportPdf,
  onExportText,
  onExportGenealogy,
  onCheckParentEvidence = noParentEvidence,
}: {
  onClose: () => void;
  onExportPdf: (signal: AbortSignal) => Promise<void>;
  onExportText: (signal: AbortSignal) => Promise<void>;
  onExportGenealogy?: (format: GenealogyExportFormat, signal: AbortSignal, onError: (message: string) => void) => Promise<void>;
  onCheckParentEvidence?: (signal: AbortSignal) => Promise<boolean>;
}) {
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [parentEvidenceCheck, setParentEvidenceCheck] = useState<{
    callback: typeof onCheckParentEvidence; value: boolean;
  } | null>(null);
  const hasParentEvidence = parentEvidenceCheck?.callback === onCheckParentEvidence
    ? parentEvidenceCheck.value : null;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!format.startsWith("ged")) return;
    const check = new AbortController();
    void onCheckParentEvidence(check.signal).then((value) => {
      if (!check.signal.aborted) setParentEvidenceCheck({ callback: onCheckParentEvidence, value });
    }).catch((reason) => {
      if (!check.signal.aborted)
        setError(reason instanceof Error ? reason.message : "Не удалось проверить состав экспорта.");
    });
    return () => check.abort();
  }, [format, onCheckParentEvidence]);

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
              onChange={(event) => {
                setParentEvidenceCheck(null);
                setFormat(event.target.value as ExportFormat);
              }}
            >
              <option value="pdf">PDF</option>
              <option value="generation-text">Поколенная роспись · TXT</option>
              {onExportGenealogy && <>
                <option value="gedzip7">GEDZIP 7 · с файлами</option>
                <option value="gedcom7">GEDCOM 7</option>
                <option value="gedcom551">GEDCOM 5.5.1</option>
              </>}
            </select>
            <button type="button" disabled={busy || (format.startsWith("ged") && hasParentEvidence === null)} onClick={() => void exportTree()}>
              <Download size={16} aria-hidden="true" /> Скачать
            </button>
          </div>
          {format.startsWith("ged") && hasParentEvidence &&
            <p role="note">Свидетельства и оценки прямого родительства передаются через расширение Drevo.
              Другие программы GEDCOM могут пропустить источники и оценки конкретного родительского ребра.</p>}
        </div>
        <p className="tree-preferences-status" role="status">
          {busy ? "Подготавливаем древо…" : status}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </EditorDialog>
  );
}
