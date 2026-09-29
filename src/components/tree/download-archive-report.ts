import { jsPDF } from "jspdf";
import { fullName, type Family } from "../../domain";
import {
  archiveReport,
  type ArchiveReport,
  type ArchiveReportKind,
} from "../../domain/archive-report";
import { base64, downloadBlob, loadPdfFontBytes } from "./tree-pdf-vector";

/** Generate a readable, selectable-text report without sending archive data to a service. */
export async function downloadArchiveReport(
  family: Family,
  personId: string | undefined,
  kind: ArchiveReportKind,
  generations: number,
  signal?: AbortSignal,
) {
  if (!personId) throw new Error("Выберите человека для отчёта.");
  const report = archiveReport(family, kind, personId, generations);
  const font = await loadPdfFontBytes(signal);
  signal?.throwIfAborted();
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "a4",
    compress: true,
    putOnlyUsedFonts: true,
  });
  pdf.addFileToVFS("Drevo.ttf", base64(font));
  pdf.addFont("Drevo.ttf", "Drevo", "normal");
  pdf.setFont("Drevo");
  pdf.setProperties({
    title: `${report.title} · ${report.subtitle}`,
    creator: "Drevo",
  });
  writeReport(pdf, report, signal);
  signal?.throwIfAborted();
  const person = family.people.find((item) => item.id === personId)!;
  downloadBlob(
    pdf.output("blob"),
    `${report.title} · ${fullName(person)}`,
    "pdf",
  );
}

function writeReport(pdf: jsPDF, report: ArchiveReport, signal?: AbortSignal) {
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const margin = 48;
  const contentWidth = width - margin * 2;
  const bottom = height - 55;
  let y = 0;
  const startPage = () => {
    y = margin;
    pdf.setFillColor(240, 246, 238);
    pdf.rect(0, 0, width, 10, "F");
  };
  const nextPage = (needed: number) => {
    if (y + needed <= bottom) return;
    pdf.addPage();
    startPage();
  };
  const wrapped = (text: string, size: number, indent = 0) => {
    pdf.setFontSize(size);
    return pdf.splitTextToSize(text, contentWidth - indent) as string[];
  };
  const write = (text: string, size: number, leading: number, indent = 0) => {
    const lines = wrapped(text, size, indent);
    pdf.setFontSize(size);
    for (const line of lines) {
      nextPage(leading);
      pdf.text(line, margin + indent, y);
      y += leading;
    }
  };

  startPage();
  pdf.setTextColor(43, 72, 49);
  write(report.title, 19, 26);
  pdf.setTextColor(81, 91, 79);
  write(report.subtitle, 12, 18);
  y += 15;

  for (const section of report.sections) {
    signal?.throwIfAborted();
    nextPage(54);
    pdf.setDrawColor(206, 221, 203);
    pdf.line(margin, y - 9, width - margin, y - 9);
    pdf.setTextColor(43, 72, 49);
    write(section.heading, 12, 19);
    y += 3;
    pdf.setTextColor(39, 48, 38);
    for (const line of section.lines) {
      signal?.throwIfAborted();
      write(line, 10, 15, line.startsWith("  ") ? 9 : 0);
      y += 4;
    }
    y += 8;
  }

  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setFontSize(9);
    pdf.setTextColor(104, 115, 102);
    pdf.text("Drevo · по записанным сведениям архива", margin, height - 27);
    pdf.text(`${page} / ${pages}`, width - margin, height - 27, {
      align: "right",
    });
  }
}
