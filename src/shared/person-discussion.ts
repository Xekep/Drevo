export const MAX_COMMENT_LENGTH = 2000;

export type PersonComment = {
  id: number;
  text: string;
  author: string;
  authorPersonId: string | null;
  createdAt: string;
  editedAt: string | null;
  canDelete: boolean;
  canEdit: boolean;
};

export type PersonDiscussionPage = {
  items: PersonComment[];
  nextBefore: number | null;
};
