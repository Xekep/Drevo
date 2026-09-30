import { archiveResourceUrl } from "./archive-context.ts";

/** Оригинал остаётся по прежнему URL. Внешние ссылки и анимации не преобразуем. */
export const mediaPreview = (
  url: string | undefined,
  variant: "tiny" | "thumb" | "display" = "thumb",
) =>
  url && /^\/media\/[a-zA-Z0-9-]+\.(jpg|png|webp)$/.test(url)
    ? `${archiveResourceUrl(url)}?variant=${variant}`
    : url && variant === "tiny" &&
        /^\/api\/shared\/[A-Za-z0-9_-]{43}\/portrait\/[^/?#]+$/.test(url)
      ? `${url}?variant=tiny`
    : url
      ? archiveResourceUrl(url)
      : url;
