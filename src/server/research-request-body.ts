import type { IncomingMessage } from "node:http";

/** Small JSON commands only; never accept archive snapshots through these APIs. */
export async function researchRequestBody(
  req: IncomingMessage,
  limit = 16_384,
): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new Error("Ожидается JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Слишком большой запрос");
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Ожидается объект");
  return value;
}
