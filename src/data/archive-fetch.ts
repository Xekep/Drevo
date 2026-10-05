import { archiveResourceUrl } from "../domain/archive-context.ts";

/** Keeps API requests in the archive selected by this tab's pathname. */
export const archiveFetch: typeof fetch = (input, init) => {
  if (typeof input === "string") return fetch(archiveResourceUrl(input), init);
  if (input instanceof URL) return fetch(archiveResourceUrl(input.href), init);
  const resource = archiveResourceUrl(input.url);
  return fetch(resource === input.url
    ? input : new Request(new URL(resource, input.url), input), init);
};
