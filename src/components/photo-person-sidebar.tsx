import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { fullName, type Family, type Person } from "../domain";
import { PersonPanel } from "./person-panel";
import { useDockSwipe } from "../hooks/useDockSwipe";

type Props = {
  person: Person;
  detailsLoading?: boolean;
  family: Family;
  isCurrentUser: boolean;
  canLoadDocuments: boolean;
  onSelect: (id: string) => void;
  onTree: (id: string) => void;
  onBack: () => void;
};

export function PhotoPersonSidebar({
  person,
  detailsLoading = false,
  family,
  isCurrentUser,
  canLoadDocuments,
  onSelect,
  onTree,
  onBack,
}: Props) {
  const sidebar = useRef<HTMLElement>(null);
  useDockSwipe(sidebar, sidebar, true, true, onBack, () => {}, true);

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
        <button type="button" onClick={onBack} aria-label="О снимке">
          <ArrowLeft size={16} />
          <span>О снимке</span>
        </button>
        <button
          type="button"
          onClick={() => onTree(person.id)}
          aria-label="Показать в древе"
        >
          <ArrowUpRight size={17} />
          <span>Показать в древе</span>
        </button>
      </div>
      {detailsLoading ? (
        <div
          className="archive-status"
          role="status"
          aria-label="Загрузка сведений человека"
        >
          <span className="archive-loader-ring" aria-hidden="true" />
        </div>
      ) : <PersonPanel
        key={person.id}
        idPrefix="photo-person"
        person={person}
        people={family.people}
        links={family.links}
        unions={family.unions}
        isCurrentUser={isCurrentUser}
        canLoadDocuments={canLoadDocuments}
        onSelect={onSelect}
      />}
    </aside>
  );
}
