import { dateInputLabel } from "../domain/dates.ts";
import {
  canUseByzantineDate,
  normalizeByzantineDate,
} from "../domain/calendar-dates.ts";

/** Anno Mundi is an era, not the Julian/Gregorian day-count distinction. */
export function ByzantineDateControl({
  text,
  checked,
  label,
  onChange,
}: {
  text: string;
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  if (!canUseByzantineDate(text)) return null;
  let hint = "Год от Сотворения мира: только сентябрьское начало года (русские акты XV–XVII веков).";
  if (checked) {
    try {
      const converted = normalizeByzantineDate(text);
      hint = `Юлианская дата: ${dateInputLabel(converted.julian)}. Новый стиль: ${dateInputLabel(converted.date)}.`;
    } catch (error) {
      hint = error instanceof Error ? error.message : "Проверьте дату.";
    }
  }
  return (
    <div className="calendar-style-control">
      <label className="check-field">
        <input type="checkbox" checked={checked} aria-label={label}
          onChange={(event) => onChange(event.target.checked)} />
        От Сотворения мира (византийская эра)
      </label>
      <small role="status">{hint}</small>
    </div>
  );
}
