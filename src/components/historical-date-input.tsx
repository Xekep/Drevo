import { dateInputLabel, validDate } from "../domain/dates";
import { julianInputLabel, normalizeCalendarDate } from "../domain/calendar-dates";
import { CalendarStyleControl } from "./calendar-style-control";

/** Keep incomplete input and the explicitly selected calendar together in the draft. */
export function HistoricalDateInput({ label, date, dateJulian, disabled, onChange }: {
  label: string;
  date?: string;
  dateJulian?: string;
  disabled?: boolean;
  onChange: (value: { date?: string; dateJulian?: string }) => void;
}) {
  const checked = dateJulian !== undefined;
  const text = checked ? validDate(dateJulian, "julian") ? julianInputLabel(dateJulian!) : dateJulian!
    : dateInputLabel(date || "");
  return <div className="calendar-date-field">
    <label>{label}<input value={text} disabled={disabled}
      placeholder="День, месяц, год или только год"
      onChange={(event) => onChange({ date: event.target.value || undefined,
        dateJulian: checked ? event.target.value : undefined })}
      onBlur={() => {
        try { onChange(normalizeCalendarDate(date, dateJulian)); }
        catch { /* The owning form validates before applying its draft. */ }
      }} /></label>
    <CalendarStyleControl text={text} label={`${label} по старому стилю`}
      checked={checked} disabled={disabled} onChange={(value) => {
        try { onChange(normalizeCalendarDate(text, value ? text : undefined)); }
        catch { onChange({ date: text || undefined, dateJulian: value ? text : undefined }); }
      }} />
  </div>;
}
