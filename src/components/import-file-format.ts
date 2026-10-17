export type ImportFileFormat =
  "gedcom" | "gedzip" | "xml" | "json" | "additions" | "drevo";

export const IMPORT_FORMAT_NAMES: Record<ImportFileFormat, string> = {
  gedcom: "GEDCOM",
  gedzip: "GEDZIP",
  xml: "XML «Древа Жизни»",
  json: "JSON Drevo",
  additions: "Пакет добавлений JSON",
  drevo: "Архив Drevo",
};

// Routing hints only. The existing server importers still validate every byte,
// ZIP member, permission, quota and reference before issuing an apply token.
export async function detectImportFileFormat(
  file: Blob,
): Promise<ImportFileFormat> {
  const prefix = new Uint8Array(await file.slice(0, 16 * 1024).arrayBuffer());
  if (prefix[0] === 0x50 && prefix[1] === 0x4b) {
    const names = await zipMemberNames(file);
    if (names.has("manifest.json") && names.has("archive.json")) return "drevo";
    if (names.has("gedcom.ged")) return "gedzip";
    if ([...names].filter((name) => /\.xml$/i.test(name)).length === 1)
      return "xml";
    throw new Error("В ZIP не найден GEDCOM, XML или архив Drevo");
  }
  const encoding =
    prefix[0] === 0xff && prefix[1] === 0xfe
      ? "utf-16le"
      : prefix[0] === 0xfe && prefix[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const text = new TextDecoder(encoding)
    .decode(prefix)
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^0\s+HEAD(?:\s|$)/i.test(text)) return "gedcom";
  if (text.startsWith("<")) return "xml";
  if (text.startsWith("{")) {
    if (file.size > 8 * 1024 * 1024) throw new Error("JSON превышает 8 МБ");
    let data: unknown;
    try {
      data = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("Не удалось прочитать JSON. Проверьте файл");
    }
    return data &&
      typeof data === "object" &&
      "format" in data &&
      data.format === "drevo.reviewed-add-only"
      ? "additions"
      : "json";
  }
  throw new Error(
    "Формат не распознан. Выберите GEDCOM, GEDZIP, XML, JSON или архив .drevo",
  );
}

/** Read only the bounded ZIP directory, without decompressing media in the browser. */
async function zipMemberNames(file: Blob) {
  const tail = new DataView(await file.slice(-65_557).arrayBuffer());
  let end = tail.byteLength - 22;
  for (; end >= 0; end--) {
    if (
      tail.getUint32(end, true) === 0x06054b50 &&
      end + 22 + tail.getUint16(end + 20, true) === tail.byteLength
    )
      break;
  }
  if (end < 0) throw new Error("Повреждён ZIP: не найден каталог файлов");
  if (tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true))
    throw new Error("Многотомные ZIP не поддерживаются");
  let size = tail.getUint32(end + 12, true);
  let offset = tail.getUint32(end + 16, true);
  if (size === 0xffffffff || offset === 0xffffffff) {
    if (end < 20 || tail.getUint32(end - 20, true) !== 0x07064b50)
      throw new Error("Повреждён каталог ZIP64");
    const location = Number(tail.getBigUint64(end - 12, true));
    if (
      !Number.isSafeInteger(location) ||
      location < 0 ||
      location + 56 > file.size
    )
      throw new Error("Повреждён каталог ZIP64");
    const zip64 = new DataView(
      await file.slice(location, location + 56).arrayBuffer(),
    );
    if (
      zip64.getUint32(0, true) !== 0x06064b50 ||
      zip64.getUint32(16, true) ||
      zip64.getUint32(20, true)
    )
      throw new Error("Недопустимый каталог ZIP64");
    size = Number(zip64.getBigUint64(40, true));
    offset = Number(zip64.getBigUint64(48, true));
  }
  if (
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(offset) ||
    size < 0 ||
    offset < 0 ||
    offset + size > file.size
  )
    throw new Error("Повреждён каталог ZIP");
  if (size > 8 * 1024 * 1024)
    throw new Error("В ZIP слишком большой каталог файлов");
  const bytes = new Uint8Array(
    await file.slice(offset, offset + size).arrayBuffer(),
  );
  const directory = new DataView(bytes.buffer);
  const names = new Set<string>();
  for (let cursor = 0, count = 0; cursor < bytes.length; count++) {
    if (
      count >= 50_000 ||
      cursor + 46 > bytes.length ||
      directory.getUint32(cursor, true) !== 0x02014b50
    )
      throw new Error("Повреждён или слишком велик каталог ZIP");
    const nameSize = directory.getUint16(cursor + 28, true);
    const next =
      cursor +
      46 +
      nameSize +
      directory.getUint16(cursor + 30, true) +
      directory.getUint16(cursor + 32, true);
    if (next > bytes.length) throw new Error("Повреждён каталог ZIP");
    names.add(
      new TextDecoder().decode(
        bytes.subarray(cursor + 46, cursor + 46 + nameSize),
      ),
    );
    cursor = next;
  }
  return names;
}
