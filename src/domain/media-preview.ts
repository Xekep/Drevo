/** Оригинал остаётся по прежнему URL. Внешние ссылки и анимации не преобразуем. */
export const mediaPreview = (
  url: string | undefined,
  variant: "thumb" | "display" = "thumb",
) =>
  url && /^\/media\/[a-zA-Z0-9-]+\.(jpg|png|webp)$/.test(url)
    ? `${url}?variant=${variant}`
    : url;
