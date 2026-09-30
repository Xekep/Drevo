import { archiveResourceUrl } from "../domain/archive-context.ts";

/** Keeps API requests in the archive selected by this tab's pathname. */
export const archiveFetch: typeof fetch = (input, init) =>
  fetch(typeof input === "string" ? archiveResourceUrl(input) : input, init);
