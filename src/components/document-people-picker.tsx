import { X } from "lucide-react";
import { PersonSearch } from "./person-search";

export type DocumentPerson = { id: string; name: string };

export function DocumentPeoplePicker({
  value,
  onChange,
  optional = true,
  disabled = false,
}: {
  value: DocumentPerson[];
  onChange: (people: DocumentPerson[]) => void;
  optional?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="document-people-picker">
      <PersonSearch
        value=""
        onChange={() => {}}
        label={`К кому относится${optional ? " · необязательно" : ""}`}
        inputAriaLabel="Найти человека для документа"
        disabled={disabled || value.length >= 30}
        excludeIds={value.map((person) => person.id)}
        onCommit={(id, person) => {
          if (
            person &&
            !disabled &&
            value.length < 30 &&
            !value.some((item) => item.id === id)
          )
            onChange([...value, { id, name: person.label }]);
        }}
      />
      <div className="documents-selected-people">
        {value.map((person) => (
          <span key={person.id}>
            {person.name}
            <button
              type="button"
              disabled={disabled}
              aria-label={`Убрать ${person.name}`}
              onClick={() =>
                onChange(value.filter((item) => item.id !== person.id))
              }
            >
              <X size={14} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
