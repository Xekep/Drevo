/** Attributes for outbound web links; relative archive links keep their behavior. */
export function externalLinkAttributes(href: string) {
  return /^(?:https?:)?\/\//i.test(href)
    ? { target: "_blank", rel: "nofollow noopener noreferrer" }
    : {};
}
