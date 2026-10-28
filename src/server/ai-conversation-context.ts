import { fullName } from "../domain/dates.ts";
import type { ResearchAnswerReference } from "../domain/research-answer.ts";
import type { Family } from "../domain/types.ts";
import type { AiChatMessage } from "./ai-chats.ts";

export const RECENT_EXCHANGE_LIMITS = {
  question: 2048,
  answer: 4096,
  references: 12,
  inspectedReferences: 64,
  label: 160,
  url: 1000,
  reference: 160,
} as const;

function bounded(value: string, limit: number) {
  return { text: value.slice(0, limit), truncated: value.length > limit };
}

function httpUrl(value: unknown) {
  if (typeof value !== "string" || value.length > RECENT_EXCHANGE_LIMITS.url)
    return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Recent conversational evidence, never a new user command or an access scope.
 * The caller supplies the currently authorized family projection. */
export function recentResearchExchange(history: readonly AiChatMessage[], family: Family) {
  let answerIndex = history.length - 1;
  while (answerIndex >= 0 && (history[answerIndex].role !== "assistant" || history[answerIndex].hidden))
    answerIndex--;
  if (answerIndex < 0) return undefined;
  let questionIndex = answerIndex - 1;
  while (questionIndex >= 0 && (history[questionIndex].role !== "user" || history[questionIndex].hidden))
    questionIndex--;
  if (questionIndex < 0) return undefined;

  const answer = history[answerIndex];
  const people = new Map(family.people.map(person => [person.id, person]));
  const photos = new Map((family.photos || []).map(photo => [photo.id, photo]));
  const references: ResearchAnswerReference[] = [];
  for (const raw of (answer.references || []).slice(0, RECENT_EXCHANGE_LIMITS.inspectedReferences)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const ref = raw as Record<string, unknown>;
    if (ref.kind === "person" && typeof ref.id === "string" && people.has(ref.id))
      references.push({ kind: "person", id: ref.id, label: fullName(people.get(ref.id)!).slice(0, RECENT_EXCHANGE_LIMITS.label) });
    else if (ref.kind === "photo" && typeof ref.id === "string" && photos.has(ref.id))
      references.push({ kind: "photo", id: ref.id, label: (photos.get(ref.id)!.title || "Фотография").slice(0, RECENT_EXCHANGE_LIMITS.label) });
    else if (ref.kind === "source" && typeof ref.personId === "string" && people.has(ref.personId) && typeof ref.label === "string")
      references.push({ kind: "source", personId: ref.personId, label: ref.label.slice(0, RECENT_EXCHANGE_LIMITS.label),
        ...(typeof ref.reference === "string" ? { reference: ref.reference.slice(0, RECENT_EXCHANGE_LIMITS.reference) } : {}),
        ...(httpUrl(ref.url) ? { url: String(ref.url) } : {}) });
    else if (ref.kind === "web" && typeof ref.label === "string") {
      const url = httpUrl(ref.url);
      if (url) references.push({ kind: "web", label: ref.label.slice(0, RECENT_EXCHANGE_LIMITS.label), url: url.href, domain: url.hostname, snippet: "" });
    }
    if (references.length >= RECENT_EXCHANGE_LIMITS.references) break;
  }
  return {
    question: bounded(history[questionIndex].content, RECENT_EXCHANGE_LIMITS.question),
    answer: bounded(answer.content, RECENT_EXCHANGE_LIMITS.answer),
    references,
  };
}
