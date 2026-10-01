import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, rm, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { readPortablePackage } from "./portable-import.ts";
import { PortablePackageError } from "./portable-package.ts";
import { verifyPortableMediaFile } from "./portable-media-check.ts";
import { discussionAttachmentStore, prepareCommentFile } from "./discussion-attachments.ts";

type Parsed = Awaited<ReturnType<typeof readPortablePackage>>;

/** Copy into fresh global names: two private archives must never own the same
 * on-disk original, even when the portable package uses the same file names.
 * Database writes follow this step; the caller must invoke undo on failure.
 */
export async function installPortableOriginals(
  parsed: Parsed,
  uploads: string,
) {
  const copies: Array<{ url: string; size: number; name: string }> = [];
  const remap = new Map<string, string>();
  const undo = async () => {
    for (const file of copies)
      await rm(join(uploads, file.name), { force: true });
    await discussionFiles.remove(savedAttachments);
  };
  const discussionFiles = discussionAttachmentStore(uploads);
  const savedAttachments: Awaited<ReturnType<typeof discussionFiles.save>> = [];
  try {
    for (const [path, file] of parsed.files) {
      if (!path.startsWith("media/")) continue;
      if (path.startsWith("media/discussion-files/")) continue;
      if (file.size <= 0)
        throw new PortablePackageError("Пустой оригинал в пакете Drevo");
      const name = `${randomUUID()}${extname(path).toLowerCase()}`;
      const target = join(uploads, name);
      await copyFile(file.path, target, constants.COPYFILE_EXCL);
      copies.push({ url: `/media/${name}`, size: file.size, name });
      const info = await lstat(target);
      if (!info.isFile() || info.size !== file.size)
        throw new PortablePackageError("Оригинал изменился при установке");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(target)) hash.update(chunk);
      if (hash.digest("hex") !== file.sha256)
        throw new PortablePackageError("SHA-256 оригинала не совпадает");
      await verifyPortableMediaFile(target, name);
      remap.set(basename(path), name);
    }
    const snapshot = structuredClone(parsed.snapshot);
    const url = (value: string) => {
      if (!value.startsWith("/media/")) return value;
      const name = remap.get(value.slice(7));
      if (!name)
        throw new PortablePackageError("В пакете нет оригинала фотографии");
      return `/media/${name}`;
    };
    for (const person of snapshot.family.people)
      if (person.photo) person.photo = url(person.photo);
    for (const photo of snapshot.family.photos || [])
      photo.url = url(photo.url);
    for (const document of snapshot.documents) {
      const name = remap.get(document.fileName);
      if (!name)
        throw new PortablePackageError("В пакете нет оригинала документа");
      document.fileName = name;
      for (const annotation of document.annotations)
        annotation.authorId = `imported:${annotation.authorId}`;
    }
    for (const comment of snapshot.comments) {
      comment.authorId = `imported:${comment.authorId}`;
      const installed = [];
      for (const file of comment.attachments || []) {
        const original = parsed.files.get(`media/discussion-files/${file.id}`);
        if (!original) throw new PortablePackageError("Нет вложения обсуждения");
        const prepared = await prepareCommentFile(file.name, await readFile(original.path));
        const saved = await discussionFiles.save([prepared]);
        savedAttachments.push(...saved);
        installed.push(...saved);
      }
      comment.attachments = installed;
    }
    return { snapshot, copies, undo };
  } catch (error) {
    await undo();
    throw error;
  }
}
