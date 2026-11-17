import { useEffect, useState } from "react";
import { archiveResourceUrl } from "../../domain/archive-context.ts";
import type { ResearchFile } from "../../shared/research-protocol.ts";

const timeFormat = new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" });

export function ResearchDownload({
  file, className, onExportTreePdf,
}: {
  file: ResearchFile & { expires?: number };
  className?: string;
  onExportTreePdf?: (scope: "all" | "current") => void;
}) {
  const { name, url, expires } = file;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (expires === undefined) return;
    const timer = setTimeout(() => setNow(Math.max(expires, Date.now())), Math.max(0, expires - Date.now()));
    return () => clearTimeout(timer);
  }, [expires]);

  if (url === "drevo:tree-pdf:current" || url === "drevo:tree-pdf:all")
    return <button className={className} type="button" disabled={!onExportTreePdf}
      onClick={() => onExportTreePdf?.(url.endsWith(":all") ? "all" : "current")}>
      Скачать {name}
    </button>;

  if (expires !== undefined && expires <= now)
    return <span className={className}>{name} · Срок ссылки истёк</span>;

  return <>
    <a className={className} href={archiveResourceUrl(url)} download={name}>
      {className ? `Скачать ${name}` : name}
    </a>
    {expires !== undefined && <small>Ссылка до {timeFormat.format(expires)}</small>}
  </>;
}
