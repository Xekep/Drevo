import { archiveContextAt, archiveResourceUrl, memberPreviewAt } from "./archive-context.ts";

/** Оригинал остаётся по прежнему URL. Внешние ссылки и анимации не преобразуем. */
export const mediaPreview = (
  url: string | undefined,
  variant: "tiny" | "avatar" | "thumb" | "display" | "print" = "thumb",
) => {
  if (!url) return url;
  // Resolve access scope before inspecting the resource. Callers may already
  // have scoped a URL; stripping its prefix for matching must never strip the
  // prefix from the request or bypass participant-preview restrictions.
  const resource = archiveResourceUrl(url);
  const path = memberPreviewAt(resource)?.innerPath ??
    archiveContextAt(resource)?.innerPath ?? resource;
  if (/^\/media\/[a-zA-Z0-9-]+\.(jpg|png|webp)$/.test(path) ||
      ((variant === "tiny" || variant === "avatar" || variant === "print") &&
        /^\/api\/shared\/[A-Za-z0-9_-]{43}\/portrait\/[^/?#]+$/.test(path)))
    return `${resource}?variant=${variant}`;
  return resource;
};
