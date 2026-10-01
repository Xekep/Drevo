import DOMPurify from "dompurify";

let sequence = 0;
const engine = () =>
  import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 2000,
      maxEdges: 100,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "base",
      themeVariables: {
        primaryColor: "#edf3e7",
        primaryBorderColor: "#78977a",
        primaryTextColor: "#263b2c",
        lineColor: "#647865",
      },
    });
    return mermaid;
  });
let loading: ReturnType<typeof engine> | undefined;

/** Enhance only recognized fenced blocks; raw HTML is sanitized separately. */
export function enhanceCommentDiagrams(
  root: HTMLElement,
  onLayout?: () => void,
) {
  let active = true;
  for (const code of root.querySelectorAll<HTMLElement>(
    "pre > code.language-mermaid",
  )) {
    const source = code.textContent || "";
    const host = document.createElement("div");
    host.className = "comment-diagram";
    host.setAttribute("role", "img");
    host.setAttribute("aria-label", "Схема Mermaid");
    host.textContent = "Загружаем схему…";
    code.parentElement!.replaceWith(host);
    const id = `comment-diagram-${++sequence}`;
    void (async () => {
      try {
        // CodeMirror attaches replacement widgets after toDOM returns.
        await Promise.resolve();
        // Per-message configuration must not weaken the application's settings.
        if (/^\s*---/.test(source) || /%%\s*\{/.test(source))
          throw new Error("config");
        const mermaid = await (loading ??= engine());
        if (!active || !host.isConnected) return;
        const { svg } = await mermaid.render(id, source);
        if (!active || !host.isConnected) return;
        const fragment = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ["foreignObject", "image"],
          FORBID_ATTR: ["href", "xlink:href"],
          RETURN_DOM_FRAGMENT: true,
        });
        // SVG styles may reference local markers, never external resources.
        const styles = (value: string) =>
          value
            .replace(/@import[^;]*;/gi, "")
            .replace(/url\(([^)]*)\)/gi, (all, target: string) =>
              target
                .trim()
                .replace(/^['"]|['"]$/g, "")
                .startsWith("#")
                ? all
                : "none",
            );
        for (const node of fragment.querySelectorAll("[style]"))
          node.setAttribute("style", styles(node.getAttribute("style")!));
        for (const style of fragment.querySelectorAll("style"))
          style.textContent = styles(style.textContent || "");
        host.replaceChildren(fragment);
        onLayout?.();
      } catch {
        if (!active || !host.isConnected) return;
        host.removeAttribute("role");
        host.classList.add("is-error");
        const error = document.createElement("p");
        error.textContent =
          "Не удалось построить схему. Проверьте синтаксис Mermaid.";
        const pre = document.createElement("pre");
        pre.textContent = source;
        host.replaceChildren(error, pre);
        onLayout?.();
      } finally {
        document.getElementById(`d${id}`)?.remove();
      }
    })();
  }
  return () => {
    active = false;
  };
}
