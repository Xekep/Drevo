export const MAX_COMMENT_LENGTH = 2000;
export const MAX_COMMENT_FILES = 8;
export const MAX_COMMENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_COMMENT_FILES_BYTES = 20 * 1024 * 1024;
export const COMMENT_FILE_ACCEPT =
  ".jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,.md,.csv,.tsv,.json,.ged,.zip,.doc,.docx,.xls,.xlsx";

export type CommentAttachmentFile = {
  id: string;
  name: string;
  type: string;
  size: number;
};
export type CommentAttachment = CommentAttachmentFile & {
  url: string;
  previewUrl?: string;
};

export const commentFileId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validCommentFileName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 160 &&
    !Array.from(name).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        character === "/" ||
        character === "\\" ||
        (character.length === 1 &&
          character.charCodeAt(0) >= 0xd800 &&
          character.charCodeAt(0) <= 0xdfff),
    )
  );
}

export function validCommentFiles(
  value: unknown,
): value is CommentAttachmentFile[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_COMMENT_FILES &&
    new Set(value.map((file) => file?.id)).size === value.length &&
    value.every(
      (file) =>
        file &&
        typeof file.id === "string" &&
        commentFileId.test(file.id) &&
        validCommentFileName(file.name) &&
        typeof file.type === "string" &&
        file.type.length <= 100 &&
        Number.isSafeInteger(file.size) &&
        file.size > 0 &&
        file.size <= MAX_COMMENT_FILE_BYTES,
    ) &&
    value.reduce((sum, file) => sum + file.size, 0) <= MAX_COMMENT_FILES_BYTES
  );
}

export type PersonComment = {
  id: number;
  text: string;
  author: string;
  authorPersonId: string | null;
  createdAt: string;
  editedAt: string | null;
  canDelete: boolean;
  canEdit: boolean;
  attachments: CommentAttachment[];
};

export type PersonDiscussionPage = {
  items: PersonComment[];
  nextBefore: number | null;
  total: number;
};
