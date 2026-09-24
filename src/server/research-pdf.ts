import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";

const font = fileURLToPath(
  new URL("../../assets/DejaVuSans.ttf", import.meta.url),
);

export async function researchPdf(
  title: string,
  content: string,
): Promise<Buffer> {
  if (
    !title.trim() ||
    title.length > 160 ||
    !content.trim() ||
    content.length > 30_000
  )
    throw new RangeError(
      "Некорректный заголовок или объём документа (до 30 000 символов)",
    );

  const document = new PDFDocument({
    size: "A4",
    margin: 48,
    info: { Title: title },
  });
  document.registerFont("Drevo", font);
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  document.font("Drevo").fontSize(18).text(title.trim(), { lineGap: 4 });
  document.moveDown(0.8);
  for (const line of content.split(/\r?\n/)) {
    const value = line
      .replace(/\[\[(?:person|photo):[^|\]]+\|([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)]+|#[^)]+)\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (!value) {
      document.moveDown(0.5);
      continue;
    }
    const heading = /^#{1,4}\s+/.test(value);
    document
      .fontSize(heading ? 13 : 10.5)
      .text(value.replace(/^#{1,4}\s+/, "").replace(/^[-*]\s+/, "• "), {
        lineGap: 4,
        paragraphGap: heading ? 7 : 3,
      });
  }
  document.end();
  return completed;
}
