import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Search, UserSearch } from "lucide-react";
import { fullName, years, type Person } from "../../domain";

/** Local navigation only: search is restricted to people in this 3D scene. */
export function SpatialPersonPicker({ people, focused, disabled, onChoose }: {
  people: Person[];
  focused?: Person;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const name = focused ? fullName(focused) : "Выбрать человека";
  const matches = people.filter(person => fullName(person)
    .toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
  useEffect(() => {
    if (!open) return;
    if (!window.matchMedia("(max-width: 899px)").matches)
      input.current?.focus({ preventScroll: true });
    else trigger.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Node) ||
        !root.current?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <div className="tree-spatial-picker" ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}>
      <button ref={trigger} type="button" className="tree-spatial-person-name"
        aria-label={`Выбрать человека: ${name}`} title={name}
        aria-expanded={open} aria-controls={open ? id : undefined}
        aria-haspopup="dialog" disabled={disabled}
        onClick={() => { setQuery(""); setOpen(!open); }}>
        <UserSearch className="tree-spatial-picker-icon" size={19} aria-hidden="true" />
        <span>{name}</span><ChevronDown className="tree-spatial-picker-chevron" size={16} aria-hidden="true" />
      </button>
      {open && <div id={id} role="dialog" aria-label="Выбрать человека в 3D"
        className="tree-spatial-people">
        <label>
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Поиск в 3D-древе</span>
          <input ref={input} type="search" placeholder="Имя или фамилия"
            value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                root.current?.querySelector<HTMLButtonElement>("li button")?.focus();
              }
            }} />
        </label>
        <ul>
          {matches.slice(0, 50).map(person => <li key={person.id}>
            <button type="button" disabled={disabled}
              aria-current={focused?.id === person.id ? "true" : undefined}
              onKeyDown={(event) => {
                const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>("li button")];
                const index = buttons.indexOf(event.currentTarget);
                const next = event.key === "ArrowDown" ? index + 1 :
                  event.key === "ArrowUp" ? index - 1 : null;
                if (next !== null) {
                  event.preventDefault();
                  if (next < 0) input.current?.focus();
                  else buttons[Math.min(next, buttons.length - 1)]?.focus();
                }
              }}
              onClick={() => { setOpen(false); onChoose(person.id); }}>
              <span>{fullName(person)}</span><small>{years(person)}</small>
            </button>
          </li>)}
        </ul>
        {!matches.length && <p role="status">Никого не нашли</p>}
        {matches.length > 50 && <p>Уточните имя для поиска остальных</p>}
      </div>}
    </div>
  );
}
