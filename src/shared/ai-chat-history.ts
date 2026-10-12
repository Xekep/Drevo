export type AiChatHead = { lastMessageId: number; version: number };
export type AiChatHistoryPage<Message> = {
  messages: Array<Message & { id: number; version: number }>;
  nextBefore: number | null;
  latestMessageId: number;
  latestVersion: number;
  hasMore: boolean;
};
export type AiChatMessageDelta<Message> = {
  messages: Array<Message & { id: number; version: number }>;
  lastVersion: number;
  hasMore: boolean;
};
export type AiChatResponse<Message> = {
  chat: { id: string; createdAt: string; updatedAt: string; busy: boolean; lastMessageId: number };
  messages: Array<Message & { id: number; version: number }>;
  latestMessageId: number;
  latestVersion: number;
  nextBefore: number | null;
  hasMore: boolean;
};
export const AI_CHAT_HISTORY_PAGE_SIZE = 100;
export const AI_CHAT_HISTORY_PAGE_BYTES = 8 * 1024 ** 2;
