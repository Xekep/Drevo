export function photoFileError(file: { type: string; size: number }): string {
  return /^image\/(jpeg|png|webp|gif)$/.test(file.type) &&
    file.size > 0 &&
    file.size <= 20 * 1024 * 1024
    ? ""
    : "Выберите JPG, PNG, WebP или GIF размером до 20 МБ.";
}
