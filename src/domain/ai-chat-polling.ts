/** Transport cursors are independent of optimistic messages still owned by SSE. */
export function chatPollDelay(busy: boolean, failures = 0) {
  return failures ? Math.min(60_000, 5_000 * 2 ** Math.min(failures, 4)) : busy ? 2_000 : 30_000;
}
export function mergeChatDelta<T extends { id?: number; version?: number; hidden?: boolean; role: string; content: string; activities?: string[] }>(current: T[], incoming: T[], historyPage = false): T[] {
  if (!incoming.length) return current;
  const persisted = new Map(current.flatMap(message => message.id === undefined ? [] : [[message.id, message] as const]));
  const optimistic = current.filter(message => message.id === undefined);
  const minimum = Math.min(...persisted.keys());
  for (const message of incoming) {
    if (message.id === undefined) continue;
    if (message.hidden) { persisted.delete(message.id); continue; }
    const previous = persisted.get(message.id);
    if (previous && (previous.version ?? 0) > (message.version ?? 0)) continue;
    // Edits on an unloaded older page must not appear at the end of the chat.
    if (!previous && persisted.size && !historyPage && message.id < minimum) continue;
    const pendingIndex = optimistic.findIndex(item => item.role === message.role && item.content === message.content);
    const pending = pendingIndex < 0 ? undefined : optimistic.splice(pendingIndex, 1)[0];
    const activities = previous?.activities ?? pending?.activities;
    persisted.set(message.id, activities ? { ...message, activities } : message);
  }
  return [...persisted.values()].sort((a, b) => a.id! - b.id!).concat(optimistic);
}
