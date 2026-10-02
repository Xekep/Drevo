export type DocumentAnnotation = {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  canDelete?: boolean;
  canEdit?: boolean;
};

export type AnnotationSelection = Pick<
  DocumentAnnotation,
  "page" | "x" | "y" | "width" | "height" | "text"
>;

export function validAnnotationSelection(
  value: unknown,
): value is AnnotationSelection {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (
    !Number.isInteger(item.page) ||
    (item.page as number) < 1 ||
    (item.page as number) > 2000 ||
    typeof item.text !== "string" ||
    !item.text.trim() ||
    item.text.trim().length > 2000
  )
    return false;
  for (const key of ["x", "y", "width", "height"] as const)
    if (typeof item[key] !== "number" || !Number.isFinite(item[key]))
      return false;
  return (
    (item.x as number) >= 0 &&
    (item.y as number) >= 0 &&
    (item.width as number) > 0.005 &&
    (item.height as number) > 0.005 &&
    (item.x as number) + (item.width as number) <= 1.00001 &&
    (item.y as number) + (item.height as number) <= 1.00001
  );
}
