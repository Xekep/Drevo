import type { DocumentDetails } from "../shared/document-details";

const fields = [
  { key: "documentType", label: "Тип", limit: 80, placeholder: "Например, метрическая запись" },
  { key: "documentDate", label: "Дата или период", limit: 80, placeholder: "Например, 1887 год" },
  { key: "place", label: "Место", limit: 200, placeholder: "" },
  { key: "provenance", label: "Происхождение", limit: 500, placeholder: "Архив, фонд, опись, дело или владелец оригинала" },
] as const;

export function DocumentDetailsFields({
  value,
  onChange,
  expanded = false,
}: {
  value: DocumentDetails;
  onChange: (key: keyof DocumentDetails, value: string) => void;
  expanded?: boolean;
}) {
  return (
    <details className="documents-extra" open={expanded || undefined}>
      <summary>Сведения о документе</summary>
      <div className="documents-extra-grid">
        {fields.map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              value={value[field.key]}
              maxLength={field.limit}
              placeholder={field.placeholder}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          </label>
        ))}
        <label className="documents-extra-description">
          Описание
          <textarea
            value={value.description}
            maxLength={1000}
            rows={3}
            onChange={(event) => onChange("description", event.target.value)}
          />
        </label>
      </div>
    </details>
  );
}
