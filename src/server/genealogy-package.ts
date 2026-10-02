import { MAX_PDF_BYTES } from "../shared/upload-limits.ts";
import { documentFileTypeFromName } from "../shared/document-file.ts";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  unlink,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable, type Writable } from "node:stream";
import { openPromise } from "yauzl";
import { ZipFile } from "yazl";
import sharp from "sharp";
import type { StoreDatabase } from "./store-database.ts";
import { importGedcom, exportGedcom } from "../domain/gedcom.ts";
import { importAgelongXml } from "../domain/agelong-xml.ts";
import {
  familyMedia,
  TRANSFER_FILE_LIMIT,
  TRANSFER_TEXT_LIMIT,
  TRANSFER_PACKAGE_LIMIT,
  TRANSFER_XML_LIMIT,
  type GenealogyImport,
  type TransferMedia,
} from "../domain/genealogy-transfer.ts";
import type { Family } from "../domain/types.ts";
import { validateFamily } from "../domain/validation.ts";
import { documentImageExtension, tiffDocumentPages } from "./document-images.ts";
import { decodeAnsel } from "../domain/ansel.ts";

export type StagedMedia = {
  name: string;
  size: number;
  title: string;
  personIds: string[];
  documentId?: string;
  document?: TransferMedia["document"];
};
export type PreparedImport = GenealogyImport & { files: StagedMedia[] };

/** ZIP names and GEDCOM URI paths use different escaping rules. Neither is a disk path. */
export function packagePath(path: string): string {
  if (
    !path ||
    path.length > 1024 ||
    /[\\:]/.test(path) ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Недопустимый путь вложения в пакете");
  return path;
}

export function decodeGedcom(bytes: Buffer): string {
  if (bytes.length > TRANSFER_TEXT_LIMIT)
    throw new Error("GEDCOM больше 32 МБ");
  const utf16 =
    bytes[0] === 255 && bytes[1] === 254
      ? "utf-16le"
      : bytes[0] === 254 && bytes[1] === 255
        ? "utf-16be"
        : bytes[0] === 48 && bytes[1] === 0
          ? "utf-16le"
          : bytes[0] === 0 && bytes[1] === 48
            ? "utf-16be"
            : undefined;
  const declaration = /(?:^|\r?\n)1 CHAR ([^\r\n]+)/
    .exec(bytes.toString("latin1"))?.[1]
    .trim()
    .toUpperCase();
  let text: string;
  try {
    text =
      declaration === "ANSEL"
        ? decodeAnsel(bytes)
        : new TextDecoder(
            utf16 ||
              (declaration === "ANSI" || declaration === "WINDOWS-1251"
                ? "windows-1251"
                : "utf-8"),
            { fatal: true },
          ).decode(bytes);
  } catch {
    throw new Error(
      "Не удалось прочитать кодировку GEDCOM. Используйте UTF-8 или UTF-16.",
    );
  }
  if (
    /^2 VERS 7\./m.test(text) &&
    (utf16 || (declaration && declaration !== "UTF-8"))
  )
    throw new Error("GEDCOM 7 должен использовать UTF-8");
  if (declaration === "ASCII" && bytes.some((byte) => byte > 127))
    throw new Error("Файл ASCII содержит символы вне ASCII");
  if (
    utf16 ||
    declaration === "ANSEL" ||
    declaration === "ANSI" ||
    declaration === "WINDOWS-1251"
  )
    text = text.replace(/^1 CHAR [^\r\n]+/m, "1 CHAR UTF-8");
  return text;
}

async function unpack(
  path: string,
  directory: string,
): Promise<Map<string, string>> {
  const zip = await openPromise(path, {
    // Windows Compress-Archive writes backslashes in ZIP entry names. yauzl
    // normalizes them to '/' before packagePath rejects traversal and drives.
    strictFileNames: false,
    validateEntrySizes: true,
  });
  const files = new Map<string, string>(),
    names = new Set<string>();
  let total = 0;
  try {
    if (zip.entryCount > 20000)
      throw new Error("В пакете больше 20 000 файлов");
    for await (const entry of zip.eachEntry()) {
      const directoryEntry = entry.fileName.endsWith("/");
      const name = packagePath(
        directoryEntry ? entry.fileName.slice(0, -1) : entry.fileName,
      );
      if (names.has(name)) throw new Error("Повтор имени файла в ZIP");
      names.add(name);
      if (
        entry.isEncrypted() ||
        ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
      )
        throw new Error("Зашифрованные файлы и ссылки в ZIP не поддерживаются");
      if (directoryEntry) {
        if (entry.uncompressedSize) throw new Error("Некорректный каталог ZIP");
        continue;
      }
      total += entry.uncompressedSize;
      const limit = /\.(ged|gedcom|xml)$/i.test(name)
        ? TRANSFER_TEXT_LIMIT
        : MAX_PDF_BYTES;
      if (entry.uncompressedSize > limit || total > TRANSFER_PACKAGE_LIMIT)
        throw new Error(
          "Превышен размер распакованного пакета (512 МиБ; PDF/TIFF 50 МиБ, фото 20 МиБ)",
        );
      const destination = join(directory, randomUUID());
      let size = 0,
        checksum = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > limit)
            return callback(new Error("Вложение превышает допустимый размер"));
          checksum = crc32(chunk, checksum);
          callback(null, chunk);
        },
      });
      await pipeline(
        await zip.openReadStreamPromise(entry),
        guard,
        createWriteStream(destination, { flags: "wx" }),
      );
      if (size !== entry.uncompressedSize || checksum !== entry.crc32)
        throw new Error("Повреждён файл ZIP: размер или CRC не совпадает");
      files.set(name, destination);
    }
    return files;
  } finally {
    zip.close();
  }
}

export async function prepareGenealogyImport(
  input: string,
  directory: string,
  namespace: string,
): Promise<PreparedImport> {
  const handle = await open(input, "r");
  const signature = Buffer.alloc(2);
  try {
    if ((await handle.stat()).size > TRANSFER_PACKAGE_LIMIT)
      throw new Error("Пакет больше 512 МиБ");
    await handle.read(signature, 0, 2, 0);
  } finally {
    await handle.close();
  }
  let entries = new Map<string, string>(),
    textBytes: Buffer = Buffer.alloc(0),
    base = "",
    zipped = false;
  const zip = signature[0] === 0x50 && signature[1] === 0x4b;
  if (zip) {
    entries = await unpack(input, directory);
    const ged = entries.get("gedcom.ged");
    if (ged) {
      textBytes = await readFile(ged);
      zipped = true;
    } else {
      const xml = [...entries.keys()].filter((p) => /\.xml$/i.test(p));
      if (xml.length !== 1)
        throw new Error(
          "GEDZIP должен содержать gedcom.ged в корне; XML ZIP — один файл .xml",
        );
      textBytes = await readFile(entries.get(xml[0])!);
      base = xml[0].includes("/")
        ? xml[0].slice(0, xml[0].lastIndexOf("/") + 1)
        : "";
    }
  } else textBytes = await readFile(input);
  const xml = /^\s*</.test(textBytes.toString("utf8").replace(/^\uFEFF/, ""));
  if (xml && entries.size) {
    let xmlPackageBytes = 0;
    for (const file of entries.values())
      xmlPackageBytes += (await lstat(file)).size;
    if (xmlPackageBytes > TRANSFER_XML_LIMIT)
      throw new Error("XML с вложениями больше 256 МиБ");
  }
  const parsed = xml
    ? importAgelongXml(
        new TextDecoder("utf-8", { fatal: true }).decode(textBytes),
        namespace,
      )
    : importGedcom(decodeGedcom(textBytes), namespace);
  if (zipped && !parsed.version.startsWith("7.0"))
    throw new Error("GEDZIP требует GEDCOM версии 7.0.x");
  const result: PreparedImport = { ...parsed, files: [] };
  const loaded = new Map<string, StagedMedia>();
  const importedDocuments = new Map<string, string>();
  let embeddedTotal = 0;
  for (const item of parsed.media) {
    let source: string | undefined;
    const sourceKey = item.embedded ? item.id : item.file;
    let stored = loaded.get(sourceKey);
    if (!stored) {
      if (item.embedded) {
        const encoded = item.embedded.replace(/\s/g, "");
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            encoded,
          ) ||
          encoded.length > Math.ceil(MAX_PDF_BYTES / 3) * 4
        )
          throw new Error(
            "Некорректное или слишком большое base64-вложение XML",
          );
        const data = Buffer.from(encoded, "base64");
        embeddedTotal += data.length;
        if (embeddedTotal > TRANSFER_XML_LIMIT)
          throw new Error("Вложения XML больше 256 МиБ");
        source = join(directory, randomUUID());
        await writeFile(source, data, { flag: "wx" });
      } else if (/^(?:https?|ftp):\/\//i.test(item.file)) {
        result.warnings.push(
          `Внешний файл «${item.title}» не загружен; скачайте его отдельно.`,
        );
        continue;
      } else if (entries.size) {
        const name = packagePath(
          xml ? item.file : decodeURIComponent(item.file),
        );
        source = entries.get(base + name);
        if (!source) throw new Error(`В пакете отсутствует вложение: ${name}`);
      } else {
        result.warnings.push(
          `Файл «${item.title}» отсутствует. Для переноса вложений выберите GEDZIP или XML вместе с папкой .files в ZIP.`,
        );
        continue;
      }
      const data = await readFile(source);
      if (data.length > MAX_PDF_BYTES) throw new Error("Вложение больше 50 МБ");
      let extension: string;
      if (data.subarray(0, 5).toString("ascii") === "%PDF-") extension = "pdf";
      else {
        try {
          extension = documentImageExtension(data);
        } catch {
          result.warnings.push(
            `Файл «${item.title}» не перенесён: поддерживаются TIFF, JPEG, PNG, GIF, WebP и PDF.`,
          );
          continue;
        }
        if (extension !== "tif" && data.length > TRANSFER_FILE_LIMIT)
          throw new Error("Фотография больше 20 МБ");
        if (extension === "tif") await tiffDocumentPages(source);
        await sharp(data, { limitInputPixels: 50_000_000 })
          .resize(1, 1)
          .toBuffer();
      }
      const id = randomUUID(),
        name = `${id}.${extension}`;
      await copyFile(source, join(directory, name), constants.COPYFILE_EXCL);
      let document = item.document;
      if (xml && extension !== "pdf" && extension !== "tif" && document) {
        if (document.eventLinks?.length)
          result.warnings.push(`Файл «${item.title}» оказался изображением: связь с событием не перенесена, портрет и фото сохранены.`);
        document = undefined;
      }
      if (xml && (extension === "pdf" || extension === "tif")) {
        const description = document?.description || item.photo?.description || "";
        if (description.length > 1000)
          result.warnings.push(`Описание документа «${item.title}» сокращено до 1000 символов; сохраните исходный XML.`);
        const shortDescription = description.slice(0, 1000).replace(/[\uD800-\uDBFF]$/, "");
        document = {
          documentType: "", documentDate: "", place: "", provenance: "", ...document,
          description: shortDescription,
        };
      }
      stored = {
        name,
        size: data.length,
        title: item.title,
        personIds: [],
        documentId: extension === "pdf" || extension === "tif" || document ? id : undefined,
        document: extension === "pdf" || extension === "tif" || document ? document : undefined,
      };
      loaded.set(sourceKey, stored);
      result.files.push(stored);
    }
    stored.personIds = [...new Set([...stored.personIds, ...item.personIds])];
    if (stored.documentId) importedDocuments.set(item.id, stored.documentId);
    if (!stored.documentId) {
      const url = `/media/${stored.name}`;
      const tags = item.photo?.tags.length
        ? item.photo.tags
        : item.personIds.map((personId, i) => ({
            id: `${item.id}-t${i}`,
            personId,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          }));
      result.family.photos!.push({
        ...item.photo,
        id: item.id,
        title: item.title,
        url,
        tags,
      });
      for (const id of item.portraitIds) {
        const person = result.family.people.find((p) => p.id === id);
        if (person) person.photo = url;
      }
    }
  }
  for (const link of parsed.citationMedia || []) {
    const documentId = importedDocuments.get(link.mediaId);
    if (documentId) {
      link.source.documentId = documentId;
      if (link.page !== undefined) link.source.documentPage = link.page;
    } else
      result.warnings.push("Вложение цитаты не загружено; связь с документом не восстановлена.");
  }
  delete result.citationMedia;
  if (result.files.length)
    result.warnings = result.warnings.filter(
      (w) => !w.startsWith("Файлы фотографий и документов не загружаются"),
    );
  validateFamily(result.family);
  // Original base64 is no longer needed in the persistent stage.
  result.media = [];
  return result;
}

export async function exportMedia(
  db: StoreDatabase,
  family: Family,
): Promise<TransferMedia[]> {
  const media = familyMedia(family);
  const rows = await db
    .prepare(
      "SELECT id,title,file_name,document_type,document_date,place,description,provenance,event_links,pages FROM documents ORDER BY id",
      "SELECT id,title,file_name,document_type,document_date,place,description,provenance,event_links,pages FROM documents ORDER BY id",
    )
    .all();
  const associations = await db
    .prepare(
      "SELECT document_id,person_id FROM document_people ORDER BY document_id,person_id",
      "SELECT document_id,person_id FROM document_people ORDER BY document_id,person_id",
    )
    .all();
  const peopleByDocument = new Map<string, string[]>();
  for (const row of associations) {
    const id = String(row.document_id);
    const people = peopleByDocument.get(id) || [];
    people.push(String(row.person_id));
    peopleByDocument.set(id, people);
  }
  for (const row of rows)
    media.push({
      id: String(row.id),
      file: `documents/${row.file_name}`,
      title: String(row.title),
      mime: documentFileTypeFromName(String(row.file_name))?.mime || "application/pdf",
      personIds: peopleByDocument.get(String(row.id)) || [],
      portraitIds: [],
      document: {
        documentType: String(row.document_type || ""),
        documentDate: String(row.document_date || ""),
        place: String(row.place || ""),
        description: String(row.description || ""),
        provenance: String(row.provenance || ""),
        ...(String(row.event_links || "[]") !== "[]"
          ? { eventLinks: JSON.parse(String(row.event_links)) } : {}),
        ...(String(row.pages || "[]") !== "[]"
          ? { pages: JSON.parse(String(row.pages)) } : {}),
      },
    });
  return media;
}

async function preparePackage(
  uploads: string,
  family: Family,
  media: TransferMedia[],
  limited: boolean,
) {
  const used = new Set<string>();
  const files: Array<{ source: string; name: string }> = [];
  let size = 0;
  const exported = media.map((m) => ({ ...m }));
  for (const item of exported) {
    const match =
      /^(?:\/media\/|documents\/)([a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|tif|pdf))$/.exec(
        item.file,
      );
    if (!match)
      throw new Error(
        `Невозможно упаковать файл «${item.title}»: оригинал отсутствует в хранилище Drevo`,
      );
    const name = `media/${match[1]}`;
    const source = join(uploads, match[1]);
    item.file = name;
    if (used.has(name)) continue;
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Оригинал «${item.title}» не является обычным файлом`);
    size += info.size;
    if (
      limited &&
      (info.size >
        (/\.(?:pdf|tif)$/.test(name) ? MAX_PDF_BYTES : TRANSFER_FILE_LIMIT) ||
        size > TRANSFER_PACKAGE_LIMIT - TRANSFER_TEXT_LIMIT)
    )
      throw new Error(
        "Слишком большой пакет обмена: GEDZIP поддерживает до 480 МиБ оригиналов. GEDCOM без файлов доступен отдельно.",
      );
    used.add(name);
    files.push({ source, name });
  }
  const text = Buffer.from(
    exportGedcom(family, { version: "7.0", media: exported }),
  );
  if (text.length > TRANSFER_TEXT_LIMIT)
    throw new Error("Текст обмена больше 32 МБ");
  return { files, text };
}

async function writePackage(
  outputStream: Writable,
  prepared: Awaited<ReturnType<typeof preparePackage>>,
) {
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream, outputStream);
  void output.catch(() => {});
  zip.on("error", (error) => (zip.outputStream as Readable).destroy(error));
  try {
    for (const file of prepared.files)
      zip.addFile(file.source, file.name, { compress: false });
    zip.addBuffer(prepared.text, "gedcom.ged");
    zip.end();
    await output;
  } catch (error) {
    (zip.outputStream as Readable).destroy(error as Error);
    await output.catch(() => {});
    throw error;
  }
}

export async function writeGenealogyPackage(
  destination: string,
  uploads: string,
  family: Family,
  media: TransferMedia[],
) {
  const prepared = await preparePackage(uploads, family, media, true);
  await writePackage(createWriteStream(destination, { flags: "wx" }), prepared);
}

/** Large owner exports stream directly to the response without a second copy
 * on the server. The GEDZIP import limit remains a separate safety boundary.
 */
export async function streamGenealogyPackage(
  destination: Writable,
  uploads: string,
  family: Family,
  media: TransferMedia[],
  beforeStart: () => Promise<void>,
) {
  const prepared = await preparePackage(uploads, family, media, false);
  await beforeStart();
  await writePackage(destination, prepared);
}

export async function installTransferFiles(
  stageDirectory: string,
  uploads: string,
  files: StagedMedia[],
) {
  await mkdir(uploads, { recursive: true });
  const created: string[] = [];
  const undo = async () => {
    await Promise.all(created.map((path) => unlink(path).catch(() => {})));
  };
  try {
    for (const file of files) {
      if (!/^[a-f0-9-]{36}\.(jpg|png|webp|gif|tif|pdf)$/.test(file.name))
        throw new Error("Повреждён путь вложения предпросмотра");
      const destination = join(uploads, file.name);
      await copyFile(
        join(stageDirectory, file.name),
        destination,
        constants.COPYFILE_EXCL,
      );
      created.push(destination);
    }
    return undo;
  } catch (error) {
    await undo();
    throw error;
  }
}
