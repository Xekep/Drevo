import {
  AI_CHAT_HISTORY_PAGE_SIZE,
  type AiChatResponse,
} from "../../src/shared/ai-chat-history.ts";

/** Matches detail/history/status requests, but never a chat's /stop endpoint. */
export function aiChatDetailRoute(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/api/ai/chats/${escaped}(?:\\?.*)?$`);
}

/** A stored chat fixture with the same history/delta cursors as the HTTP API. */
export function aiChatFixture<Message extends object>(
  url: string,
  id: string,
  messages: Array<Message & { id?: number; version?: number }>,
  busy = false,
): AiChatResponse<Message> {
  const stored = messages.map((message, index) => ({
    ...message,
    id: message.id ?? index + 1,
    version: message.version ?? index + 1,
  }));
  const query = new URL(url).searchParams;
  const latestMessageId = Math.max(0, ...stored.map((message) => message.id));
  const headVersion = Math.max(0, ...stored.map((message) => message.version));
  const version = query.get("version");
  const before = query.get("before");
  const eligible = stored
    .filter((message) =>
      version !== null
        ? message.version > Number(version)
        : before === null || message.id < Number(before),
    )
    .sort((a, b) =>
      version !== null ? a.version - b.version || a.id - b.id : a.id - b.id,
    );
  const hasMore = eligible.length > AI_CHAT_HISTORY_PAGE_SIZE;
  const page =
    version !== null
      ? eligible.slice(0, AI_CHAT_HISTORY_PAGE_SIZE)
      : eligible.slice(-AI_CHAT_HISTORY_PAGE_SIZE);
  return {
    chat: {
      id,
      createdAt: "2026-10-12T12:00:00Z",
      updatedAt: "2026-10-12T12:00:00Z",
      busy,
      lastMessageId: latestMessageId,
    },
    messages: page,
    latestMessageId,
    latestVersion:
      version !== null && hasMore ? page.at(-1)!.version : headVersion,
    nextBefore: version === null && hasMore ? page[0].id : null,
    hasMore,
  };
}
