import type { Person } from "../domain/types.ts";
import { fullName } from "../domain/index.ts";
import type { DocumentEventLink, DocumentPage } from "../shared/document-links.ts";

export function DocumentRelationsFields({
  people, personIds, eventLinks, pages, onEventsChange, onPagesChange, disabled,
}: {
  people: Person[];
  personIds: string[];
  eventLinks: DocumentEventLink[];
  pages: DocumentPage[];
  onEventsChange: (value: DocumentEventLink[]) => void;
  onPagesChange: (value: DocumentPage[]) => void;
  disabled?: boolean;
}) {
  const available = people.filter((person) => personIds.includes(person.id));
  return (
    <details className="documents-extra">
      <summary>Связанные события и страницы</summary>
      <div className="documents-relations">
        <p>События выбранных людей</p>
        {available.flatMap((person) => (person.events || []).map((event) => {
          const link = eventLinks.find((item) => item.personId === person.id && item.eventId === event.id);
          return (
            <div className="documents-relation-row" key={`${person.id}:${event.id}`}>
              <label>
                <input type="checkbox" checked={!!link} disabled={disabled}
                  onChange={(change) => onEventsChange(change.target.checked
                    ? [...eventLinks, { personId: person.id, eventId: event.id }]
                    : eventLinks.filter((item) => item !== link))} />
                {fullName(person)} · {event.title || event.type}{event.date ? ` · ${event.date}` : ""}
              </label>
              {link && <label>Страница
                <input type="number" min={1} max={2000} value={link.page ?? ""} disabled={disabled}
                  onChange={(change) => {
                    const page = Number(change.target.value);
                    onEventsChange(eventLinks.map((item) => item === link
                      ? { personId: item.personId, eventId: item.eventId,
                        ...(change.target.value && Number.isInteger(page) && page >= 1 && page <= 2000 ? { page } : {}) }
                      : item));
                  }} />
              </label>}
            </div>
          );
        }))}
        {!available.some((person) => person.events?.length) && <small>У выбранных людей пока нет событий.</small>}
        <p>Описание страниц документа</p>
        {pages.map((page) => <div className="documents-relation-row" key={page.number}>
          <label>Страница
            <input type="number" min={1} max={2000} value={page.number} disabled={disabled}
              onChange={(change) => {
                const number = Number(change.target.value);
                if (!Number.isInteger(number) || number < 1 || number > 2000 ||
                    pages.some((item) => item !== page && item.number === number)) return;
                onPagesChange(pages.map((item) => item === page ? { ...item, number } : item));
              }} />
          </label>
          <label>Содержание
            <input value={page.description} maxLength={300} disabled={disabled}
              onChange={(change) => onPagesChange(pages.map((item) => item === page
                ? { ...item, description: change.target.value } : item))} />
          </label>
          <button type="button" disabled={disabled} onClick={() => onPagesChange(pages.filter((item) => item !== page))}>Удалить</button>
        </div>)}
        <button type="button" disabled={disabled || pages.length >= 200}
          onClick={() => {
            let number = 1;
            while (pages.some((page) => page.number === number)) number++;
            onPagesChange([...pages, { number, description: "" }]);
          }}>Добавить страницу</button>
      </div>
    </details>
  );
}
