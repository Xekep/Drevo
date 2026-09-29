import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { TreePreferences } from "../domain";
import type { GenealogyExportFormat } from "../domain/genealogy-transfer";
import type { TreeExportScope } from "../domain/tree-export-selection";
import type { LineageDirection } from "../domain/lineage-report";
import type { ArchiveReportKind } from "../domain/archive-report";
import type { FanExportOptions } from "./tree/fan-export";
import {
  DEFAULT_TREE_PRINT,
  type TreePrintOptions,
  type TreePrintPreview,
} from "./tree/tree-print-plan";
import { EditorDialog } from "./editor-dialog";
import "../styles/tree-preferences.css";

export function TreePreferencesDialog({
  preferences,
  canExportArchive = false,
  onChange,
  onClose,
  onExportPdf,
  onExportPng,
  onExportReport,
  onExportPdfReport,
  onExportFan,
  onPreviewPdf,
  anchorId,
  anchorName,
}: {
  preferences: TreePreferences;
  canExportArchive?: boolean;
  onChange: (value: TreePreferences) => Promise<TreePreferences>;
  onClose: () => void;
  onExportPdf: (
    signal: AbortSignal,
    scope: TreeExportScope,
    anchorId?: string,
    generations?: number,
    printOptions?: TreePrintOptions,
  ) => Promise<void>;
  onExportPng: (
    signal: AbortSignal,
    scope: TreeExportScope,
    anchorId?: string,
    generations?: number,
  ) => Promise<void>;
  onExportReport: (direction: LineageDirection, generations: number) => void;
  onExportPdfReport: (
    kind: ArchiveReportKind,
    generations: number,
    signal: AbortSignal,
  ) => Promise<void>;
  onExportFan: (
    options: FanExportOptions,
    signal: AbortSignal,
  ) => Promise<void>;
  onPreviewPdf: (
    signal: AbortSignal,
    scope: TreeExportScope,
    anchorId: string | undefined,
    generations: number,
    options: TreePrintOptions,
  ) => Promise<TreePrintPreview>;
  anchorId?: string;
  anchorName?: string;
}) {
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState("");
  const [graphicFormat, setGraphicFormat] = useState<"pdf" | "png">("pdf");
  const [exportScope, setExportScope] = useState<TreeExportScope>("current");
  const [generations, setGenerations] = useState(5);
  const [reportGenerations, setReportGenerations] = useState(5);
  const [fanGenerations, setFanGenerations] = useState(5);
  const [fanNames, setFanNames] = useState(true);
  const [fanYears, setFanYears] = useState(true);
  const [fanPortraits, setFanPortraits] = useState(false);
  const [fanUnknown, setFanUnknown] = useState(true);
  const [printOptions, setPrintOptions] =
    useState<TreePrintOptions>(DEFAULT_TREE_PRINT);
  const [printPreview, setPrintPreview] = useState<TreePrintPreview | null>(
    null,
  );
  const [reportDirection, setReportDirection] =
    useState<LineageDirection>("ancestors");
  const [pdfReportKind, setPdfReportKind] =
    useState<ArchiveReportKind>("person");
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
    setExported("");
    setError("");
    try {
      if (graphicFormat === "pdf")
        await onExportPdf(
          controller.signal,
          exportScope,
          anchorId,
          generations,
          printOptions,
        );
      else
        await onExportPng(
          controller.signal,
          exportScope,
          anchorId,
          generations,
        );
      if (!controller.signal.aborted)
        setExported(`${graphicFormat.toUpperCase()} готов.`);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Не удалось создать файл. Попробуйте ещё раз.",
        );
    } finally {
      if (!controller.signal.aborted) setExporting(false);
    }
  };
  const exportFanChart = async () => {
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExported("");
    setError("");
    try {
      await onExportFan(
        {
          generations: fanGenerations,
          names: fanNames,
          years: fanYears,
          portraits: fanPortraits,
          unknown: fanUnknown,
          format: graphicFormat,
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setExported(`Веер ${graphicFormat.toUpperCase()} готов.`);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Не удалось создать веер.",
        );
    } finally {
      if (!controller.signal.aborted) setExporting(false);
    }
  };
  const exportPdfReport = async () => {
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExported("");
    setError("");
    try {
      await onExportPdfReport(pdfReportKind, reportGenerations, controller.signal);
      if (!controller.signal.aborted) setExported("PDF-отчёт готов.");
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "Не удалось создать PDF-отчёт.");
    } finally {
      if (!controller.signal.aborted) setExporting(false);
    }
  };
  const previewPrint = async () => {
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setError("");
    try {
      const result = await onPreviewPdf(
        controller.signal,
        exportScope,
        anchorId,
        generations,
        printOptions,
      );
      if (!controller.signal.aborted) setPrintPreview(result);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Не удалось построить предпросмотр.",
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
                title: "Потомки сверху",
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
              aria-label={`Сохранить древо в ${graphicFormat.toUpperCase()}`}
              disabled={
                saving ||
                exporting ||
                (exportScope !== "current" &&
                  exportScope !== "all" &&
                  !anchorId)
              }
              onClick={() => void exportTree()}
            >
              <Download size={16} aria-hidden="true" />
              Скачать {graphicFormat.toUpperCase()}
            </button>
            <details className="tree-export-options">
              <summary>Параметры экспорта</summary>
              <div className="tree-export-options-fields">
                <label>
                  Формат изображения
                  <select
                    aria-label="Формат изображения"
                    value={graphicFormat}
                    onChange={(event) =>
                      setGraphicFormat(event.target.value as "pdf" | "png")
                    }
                    disabled={exporting}
                  >
                    <option value="pdf">PDF · векторный</option>
                    <option value="png">PNG · для публикации</option>
                  </select>
                </label>
                <label>
                  Область
                  <select
                    aria-label="Область экспорта"
                    value={exportScope}
                    onChange={(event) =>
                      setExportScope(event.target.value as TreeExportScope)
                    }
                    disabled={exporting}
                  >
                    <option value="current">Текущий вид</option>
                    <option value="all">Всё древо</option>
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
                {(exportScope === "ancestors" ||
                  exportScope === "descendants") && (
                  <label>
                    Поколений
                    <select
                      aria-label="Поколений для экспорта"
                      value={generations}
                      onChange={(event) =>
                        setGenerations(Number(event.target.value))
                      }
                      disabled={exporting}
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
                <div className="tree-export-report">
                  <select
                    aria-label="Направление росписи"
                    value={reportDirection}
                    onChange={(event) =>
                      setReportDirection(event.target.value as LineageDirection)
                    }
                  >
                    <option value="ancestors">Роспись предков</option>
                    <option value="descendants">Роспись потомков</option>
                  </select>
                  <button
                    type="button"
                    disabled={!anchorId || exporting}
                    onClick={() => {
                      setError("");
                      try {
                        onExportReport(reportDirection, reportGenerations);
                        setExported("Роспись готова.");
                      } catch (reason) {
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : "Не удалось создать роспись.",
                        );
                      }
                    }}
                  >
                    Скачать роспись
                  </button>
                  <select
                    aria-label="Тип PDF-отчёта"
                    value={pdfReportKind}
                    onChange={(event) =>
                      setPdfReportKind(event.target.value as ArchiveReportKind)
                    }
                    disabled={exporting}
                  >
                    <option value="person">Карточка человека · PDF</option>
                    <option value="family">Семейный отчёт · PDF</option>
                    <option value="timeline">Хронология жизни · PDF</option>
                    <option value="ancestors">Список предков · PDF</option>
                    <option value="descendants">Список потомков · PDF</option>
                    <option value="research">Исследовательская сводка · PDF</option>
                  </select>
                  <button
                    type="button"
                    disabled={!anchorId || exporting}
                    onClick={() => void exportPdfReport()}
                  >
                    Скачать PDF-отчёт
                  </button>
                </div>
                <label>
                  Поколений в росписи и сводке
                  <select
                    aria-label="Поколений в росписи"
                    value={reportGenerations}
                    onChange={(event) =>
                      setReportGenerations(Number(event.target.value))
                    }
                    disabled={exporting}
                  >
                    {[2, 3, 4, 5, 6, 7, 8].map((count) => (
                      <option value={count} key={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <details className="tree-export-options">
                <summary>Настройки печати PDF</summary>
                <div className="tree-export-options-fields">
                  <label>
                    Лист
                    <select
                      aria-label="Размер листа"
                      value={printOptions.paper}
                      disabled={exporting}
                      onChange={(event) => {
                        setPrintOptions({
                          ...printOptions,
                          paper: event.target
                            .value as TreePrintOptions["paper"],
                        });
                        setPrintPreview(null);
                      }}
                    >
                      <option value="large">Один большой · альбомный</option>
                      <option value="a4">A4 · несколько листов</option>
                      <option value="a3">A3 · несколько листов</option>
                    </select>
                  </label>
                  {printOptions.paper !== "large" && (
                    <>
                      <label>
                        Ориентация
                        <select
                          aria-label="Ориентация листа"
                          value={printOptions.orientation}
                          disabled={exporting}
                          onChange={(event) => {
                            setPrintOptions({
                              ...printOptions,
                              orientation: event.target
                                .value as TreePrintOptions["orientation"],
                            });
                            setPrintPreview(null);
                          }}
                        >
                          <option value="landscape">Альбомная</option>
                          <option value="portrait">Книжная</option>
                        </select>
                      </label>
                      <label>
                        Поля
                        <select
                          aria-label="Поля листа"
                          value={printOptions.marginMm}
                          disabled={exporting}
                          onChange={(event) => {
                            setPrintOptions({
                              ...printOptions,
                              marginMm: Number(event.target.value),
                            });
                            setPrintPreview(null);
                          }}
                        >
                          {[0, 5, 10, 15, 20].map((value) => (
                            <option value={value} key={value}>
                              {value} мм
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Масштаб
                        <select
                          aria-label="Масштаб печати"
                          value={printOptions.scale}
                          disabled={exporting}
                          onChange={(event) => {
                            setPrintOptions({
                              ...printOptions,
                              scale: Number(event.target.value),
                            });
                            setPrintPreview(null);
                          }}
                        >
                          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
                            <option value={value} key={value}>
                              {Math.round(value * 100)}%
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={
                      exporting ||
                      (exportScope !== "current" &&
                        exportScope !== "all" &&
                        !anchorId)
                    }
                    onClick={() => void previewPrint()}
                  >
                    Предпросмотр печати
                  </button>
                  {printPreview && (
                    <div className="tree-print-preview" role="status">
                      <strong>
                        {printPreview.columns * printPreview.rows} листов ·{" "}
                        {printPreview.columns} × {printPreview.rows}
                      </strong>
                      <svg
                        viewBox={`0 0 ${printPreview.sceneWidth} ${printPreview.sceneHeight}`}
                        role="img"
                        aria-label="Расположение карточек на листах"
                      >
                        <rect
                          x="0"
                          y="0"
                          width={printPreview.sceneWidth}
                          height={printPreview.sceneHeight}
                          fill="#fff"
                        />
                        {printPreview.cards.map((card, index) => (
                          <rect
                            key={index}
                            x={card.x}
                            y={card.y}
                            width={card.width}
                            height={card.height}
                            rx="6"
                            fill="#dce9d3"
                            stroke="#78916b"
                            strokeWidth="2"
                          />
                        ))}
                        {Array.from(
                          { length: printPreview.columns * printPreview.rows },
                          (_, index) => {
                            const usableWidth =
                              printPreview.widthPt - 2 * printPreview.marginPt;
                            const usableHeight =
                              printPreview.heightPt - 2 * printPreview.marginPt;
                            const tileWidth =
                              usableWidth / (0.75 * printPreview.scale);
                            const tileHeight =
                              usableHeight / (0.75 * printPreview.scale);
                            return (
                              <rect
                                key={index}
                                x={(index % printPreview.columns) * tileWidth}
                                y={
                                  Math.floor(index / printPreview.columns) *
                                  tileHeight
                                }
                                width={tileWidth}
                                height={tileHeight}
                                fill="none"
                                stroke="#bd7459"
                                strokeWidth="5"
                              />
                            );
                          },
                        )}
                      </svg>
                    </div>
                  )}
                </div>
              </details>
              <details className="tree-export-options">
                <summary>Экспорт веера</summary>
                <div className="tree-export-options-fields">
                  <label>
                    Поколений в веере
                    <select
                      aria-label="Поколений в веере"
                      value={fanGenerations}
                      onChange={(event) =>
                        setFanGenerations(Number(event.target.value))
                      }
                      disabled={exporting}
                    >
                      {[2, 3, 4, 5, 6].map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="tree-export-check">
                    <input
                      type="checkbox"
                      checked={fanNames}
                      onChange={(event) => setFanNames(event.target.checked)}
                    />{" "}
                    Имена
                  </label>
                  <label className="tree-export-check">
                    <input
                      type="checkbox"
                      checked={fanYears}
                      onChange={(event) => setFanYears(event.target.checked)}
                    />{" "}
                    Годы жизни
                  </label>
                  <label className="tree-export-check">
                    <input
                      type="checkbox"
                      checked={fanPortraits}
                      onChange={(event) =>
                        setFanPortraits(event.target.checked)
                      }
                    />{" "}
                    Портреты
                  </label>
                  <label className="tree-export-check">
                    <input
                      type="checkbox"
                      checked={fanUnknown}
                      onChange={(event) => setFanUnknown(event.target.checked)}
                    />{" "}
                    Неизвестные предки
                  </label>
                  <button
                    type="button"
                    disabled={!anchorId || exporting}
                    onClick={() => void exportFanChart()}
                  >
                    Скачать веер · {graphicFormat.toUpperCase()}
                  </button>
                </div>
              </details>
            </details>
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
              : exported}
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
