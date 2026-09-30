/** Never put bearer share tokens or query parameters into request logs. */
export function safeRequestRoute(url: string) {
  const path = url.split("?")[0];
  const inner = path.replace(/^\/a\/[^/]+(?=\/)/, "");
  if (inner.startsWith("/s/")) return "/s/[redacted]";
  if (inner.startsWith("/api/shared/")) return "/api/shared/[redacted]";
  return path;
}
