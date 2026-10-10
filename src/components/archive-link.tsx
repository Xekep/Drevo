import type { ComponentProps } from "react";

/** Retain native new-tab/context-menu behavior while routing a normal click. */
export function ArchiveLink({
  onNavigate,
  children,
  href,
  ...props
}: Omit<ComponentProps<"a">, "onClick"> & {
  onNavigate: () => void;
  href: string;
}) {
  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onNavigate();
      }}
    >
      {children}
    </a>
  );
}
