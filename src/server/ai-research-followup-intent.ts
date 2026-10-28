/** Quoted current-turn context, not an intent classifier. Each original message
 * is also delivered separately to the native conversation without rewriting. */
export function researchFollowupMessage(current: string, updates: readonly string[]) {
  return [current, ...updates].join("\n\n");
}
