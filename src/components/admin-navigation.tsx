import { useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";

type NavigationGroup<T extends string> = {
  label: string;
  items: readonly { id: T; label: string; icon: LucideIcon }[];
};

/** Owns selected-item visibility in the horizontally scrolling mobile navigation. */
export function AdminNavigation<T extends string>({
  groups,
  selected,
  onSelect,
  href,
  label,
}: {
  groups: readonly NavigationGroup<T>[];
  selected: T;
  onSelect: (id: T) => void;
  href: (id: T) => string;
  label: string;
}) {
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const revealSelected = () => {
      if (nav.scrollWidth <= nav.clientWidth) return;
      const selected = nav.querySelector('[aria-current="page"]');
      if (!selected) return;
      const bounds = nav.getBoundingClientRect();
      const item = selected.getBoundingClientRect();
      if (item.left < bounds.left) nav.scrollLeft += item.left - bounds.left;
      else if (item.right > bounds.right)
        nav.scrollLeft += item.right - bounds.right;
    };
    revealSelected();
    const observer = new ResizeObserver(revealSelected);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [selected]);
  return (
    <nav ref={navigation} aria-label={label}>
      {groups.map((group) => (
        <div className="admin-nav-group" key={group.label}>
          <span className="admin-nav-label">{group.label}</span>
          {group.items.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={href(id)}
              aria-current={selected === id ? "page" : undefined}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onSelect(id);
              }}
            >
              <Icon size={17} aria-hidden="true" />
              {label}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}
