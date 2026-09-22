import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowUpRight, X } from "lucide-react";
import { fullName, type Family, type Person } from "../domain";
import { PersonPanel } from "./person-panel";

type Props = {
  person: Person;
  family: Family;
  isCurrentUser: boolean;
  onSelect: (id: string) => void;
  onTree: (id: string) => void;
  onBack: () => void;
  onClose: () => void;
};

export function PhotoPersonSidebar({
  person,
  family,
  isCurrentUser,
  onSelect,
  onTree,
  onBack,
  onClose,
}: Props) {
  const sidebar = useRef<HTMLElement>(null);

  useEffect(() => {
    sidebar.current?.focus({ preventScroll: true });
    sidebar.current?.scrollTo(0, 0);
  }, [person.id]);

  return (
    <aside
      ref={sidebar}
      id="photo-person-information"
      className="photo-tools photo-person-sidebar"
      aria-label={`Сведения о человеке: ${fullName(person)}`}
      tabIndex={-1}
    >
      <div className="photo-person-sidebar-actions">
        <button type="button" onClick={onBack}>
          <ArrowLeft size={16} />О снимке
        </button>
        <button
          type="button"
          className="photo-person-sidebar-close"
          onClick={onClose}
          aria-label="Закрыть сведения о человеке"
        >
          <X size={18} />
        </button>
      </div>
      <button
        type="button"
        className="photo-person-tree-link"
        onClick={() => onTree(person.id)}
      >
        Показать в древе
        <ArrowUpRight size={17} />
      </button>
      <PersonPanel
        key={person.id}
        idPrefix="photo-person"
        person={person}
        people={family.people}
        links={family.links}
        isCurrentUser={isCurrentUser}
        onSelect={onSelect}
      />
    </aside>
  );
}
