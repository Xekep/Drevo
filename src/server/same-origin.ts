import type { IncomingMessage } from "node:http";

type RequestWithHeaders = Pick<IncomingMessage, "headers">;

/**
 * Единое правило для изменяющих HTTP-запросов из интерфейса архива.
 *
 * Отсутствующий Origin сохраняет прежнее поведение для same-origin клиентов,
 * а явный cross-site Sec-Fetch-Site блокируется независимо от Origin.
 */
export function isSameOriginRequest(
  req: RequestWithHeaders,
  publicOrigin?: string,
) {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  return !origin || origin === (publicOrigin || `http://${req.headers.host}`);
}
