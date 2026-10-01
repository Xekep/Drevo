import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { type Readable } from "node:stream";
import { ZipFile } from "yazl";
import { exportGedcom } from "../domain/gedcom.ts";
import {
  familyMedia,
  type TransferMedia,
} from "../domain/genealogy-transfer.ts";
import { treeExportPeople } from "../domain/tree-export-selection.ts";
import type { Family } from "../domain/types.ts";
import { offlineReaderHtml, type OfflineDocument } from "./offline-reader.ts";
import { documentFileTypeFromName, storedDocumentFileType } from "../shared/document-file.ts";

export type OfflineScope =
  "all" | "family" | "ancestors" | "descendants" | "blood";
const filePattern = /^\/media\/([a-f0-9-]{36}\.(?:jpg|png|webp|gif))$/;
const maxPackageBytes = 1024 * 1024 * 1024;

function withoutCreator<T extends { createdBy?: string }>(
  item: T,
): Omit<T, "createdBy"> {
  const copy = { ...item };
  delete copy.createdBy;
  return copy;
}

function relativeImage(url: string) {
  const name = filePattern.exec(url)?.[1];
  if (!name)
    throw new Error(
      "В архиве есть фотография без доступного оригинала в локальном хранилище.",
    );
  return `media/${name}`;
}

/** Select from an already-authorized projection, then remove references outside the export. */
export function offlineFamily(
  family: Family,
  scope: OfflineScope,
  anchorId?: string,
  generations = 5,
): Family {
  if (
    scope !== "all" &&
    !family.people.some((person) => person.id === anchorId)
  )
    throw new Error("Выберите доступного человека для экспорта ветки.");
  const ids = treeExportPeople(family, scope, anchorId, generations);
  const people = family.people
    .filter((person) => ids.has(person.id))
    .map((person) => ({
      ...withoutCreator(person),
      parents: person.parents.filter((id) => ids.has(id)),
      spouses: person.spouses.filter((id) => ids.has(id)),
      photo: person.photo ? relativeImage(person.photo) : undefined,
    }));
  const portraits = new Set(
    family.people
      .filter((person) => ids.has(person.id))
      .map((person) => person.photo)
      .filter((url): url is string => Boolean(url)),
  );
  const photos = (family.photos || [])
    .filter(
      (photo) =>
        scope === "all" ||
        portraits.has(photo.url) ||
        photo.tags.some((tag) => ids.has(tag.personId)),
    )
    .map((photo) => ({
      ...withoutCreator(photo),
      url: relativeImage(photo.url),
      tags: photo.tags.filter((tag) => ids.has(tag.personId)),
    }));
  return {
    title: family.title,
    description: family.description,
    demo: family.demo,
    people,
    photos,
    links: (family.links || [])
      .filter((link) => ids.has(link.from) && ids.has(link.to))
      .map(withoutCreator),
  };
}

export function offlineDocuments(
  rows: Array<{
    id: string;
    title: string;
    file_name: string;
    created_at: string;
    document_type?: string;
    document_date?: string;
    place?: string;
    description?: string;
    provenance?: string;
  }>,
  associations: Array<{ document_id: string; person_id: string }>,
  family: Family,
  includeUnlinked: boolean,
): OfflineDocument[] {
  const visible = new Set(family.people.map((person) => person.id));
  const links = new Map<string, string[]>();
  for (const row of associations)
    if (visible.has(row.person_id))
      links.set(row.document_id, [
        ...(links.get(row.document_id) || []),
        row.person_id,
      ]);
  const allLinked = new Set(associations.map((row) => row.document_id));
  return rows
    .filter(
      (row) => links.has(row.id) || (includeUnlinked && !allLinked.has(row.id)),
    )
    .map((row) => {
      if (!storedDocumentFileType(row.file_name))
        throw new Error("Некорректное имя оригинала документа.");
      return {
        id: row.id,
        title: row.title,
        file: `media/${row.file_name}`,
        createdAt: row.created_at,
        documentType: row.document_type || "",
        documentDate: row.document_date || "",
        place: row.place || "",
        description: row.description || "",
        provenance: row.provenance || "",
        personIds: links.get(row.id) || [],
      };
    });
}

async function checksum(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Build fully before sending headers so missing originals never produce a partial download. */
export async function writeOfflinePackage(
  destination: string,
  uploadsDirectory: string,
  family: Family,
  documents: OfflineDocument[],
  revision: number,
  scope: OfflineScope,
) {
  const mediaPaths = new Set<string>();
  for (const person of family.people)
    if (person.photo) mediaPaths.add(person.photo);
  for (const photo of family.photos || []) mediaPaths.add(photo.url);
  for (const document of documents) mediaPaths.add(document.file);
  const originals: Array<{
    name: string;
    path: string;
    size: number;
    sha256: string;
  }> = [];
  let total = 0;
  for (const name of [...mediaPaths].sort()) {
    if (!/^media\/[a-f0-9-]{36}\.(?:jpg|png|webp|gif|pdf)$/.test(name))
      throw new Error("Некорректный путь вложения.");
    const path = join(uploadsDirectory, name.slice(6));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Оригинал вложения недоступен.");
    total += info.size;
    if (total > maxPackageBytes)
      throw new Error("Офлайн-пакет превышает 1 ГБ; выберите меньшую ветку.");
    originals.push({
      name,
      path,
      size: info.size,
      sha256: await checksum(path),
    });
  }
  const transfer: TransferMedia[] = [
    ...familyMedia(family),
    ...documents.map((document) => ({
      id: document.id,
      file: document.file,
      title: document.title,
      mime: documentFileTypeFromName(document.file)?.mime || "application/pdf",
      personIds: document.personIds,
      portraitIds: [],
      document: {
        documentType: document.documentType || "",
        documentDate: document.documentDate || "",
        place: document.place || "",
        description: document.description || "",
        provenance: document.provenance || "",
      },
    })),
  ];
  const buffers = new Map([
    ["index.html", Buffer.from(offlineReaderHtml(family, documents))],
    ["family.json", Buffer.from(JSON.stringify(family, null, 2))],
    ["documents.json", Buffer.from(JSON.stringify(documents, null, 2))],
    [
      "gedcom.ged",
      Buffer.from(exportGedcom(family, { version: "7.0", media: transfer })),
    ],
  ]);
  for (const content of buffers.values()) total += content.length;
  if (total > maxPackageBytes)
    throw new Error("Офлайн-пакет превышает 1 ГБ; выберите меньшую ветку.");
  const manifest = {
    format: "drevo-offline",
    version: 1,
    createdAt: new Date().toISOString(),
    revision,
    scope,
    people: family.people.length,
    photos: family.photos?.length || 0,
    documents: documents.length,
    files: [
      ...[...buffers].map(([name, content]) => ({
        name,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
      ...originals.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    ],
  };
  const zip = new ZipFile();
  const output = pipeline(
    zip.outputStream,
    createWriteStream(destination, { flags: "wx" }),
  );
  void output.catch(() => {});
  zip.on("error", (error) => (zip.outputStream as Readable).destroy(error));
  try {
    for (const [name, content] of buffers) zip.addBuffer(content, name);
    for (const item of originals)
      zip.addFile(item.path, item.name, { compress: false });
    zip.addBuffer(
      Buffer.from(JSON.stringify(manifest, null, 2)),
      "manifest.json",
    );
    zip.end();
    await output;
  } catch (error) {
    (zip.outputStream as Readable).destroy(error as Error);
    await output.catch(() => {});
    throw error;
  }
  return manifest;
}
