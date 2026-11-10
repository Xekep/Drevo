import { dateInputLabel, validDate } from "../domain/dates";
import { julianInputLabel, normalizeCalendarDate } from "../domain/calendar-dates";
import { CalendarStyleControl } from "./calendar-style-control";
import { ByzantineDateControl } from "./byzantine-date-control.tsx";

/** Keep incomplete input and the explicitly selected calendar together in the draft. */
export function HistoricalDateInput({ label, date, dateJulian, dateByzantine, disabled, onChange }: {
  label: string;
  date?: string;
  dateJulian?: string;
  dateByzantine?: string;
  disabled?: boolean;
  onChange: (value: { date?: string; dateJulian?: string; dateByzantine?: string }) => void;
}) {
  const byzantine = dateByzantine !== undefined;
  const checked = !byzantine && dateJulian !== undefined;
  const original = byzantine ? dateByzantine! : dateJulian;
  const text = byzantine || checked ? validDate(original, "julian") ? julianInputLabel(original!) : original!
    : dateInputLabel(date || "");
  return <div className="calendar-date-field">
    <label>{label}<input value={text} disabled={disabled}
      placeholder="День, месяц, год или только год"
      onChange={(event) => onChange({ date: event.target.value || undefined,
        dateJulian: checked ? event.target.value : undefined,
        dateByzantine: byzantine ? event.target.value : undefined })}
      onBlur={() => {
        try { onChange(normalizeCalendarDate(date, dateJulian, dateByzantine)); }
        catch { /* The owning form validates before applying its draft. */ }
      }} /></label>
    <CalendarStyleControl text={text} label={`${label} по старому стилю`}
      checked={checked} disabled={disabled} onChange={(value) => {
        try { onChange({ ...normalizeCalendarDate(text, value ? text : undefined), dateByzantine: undefined }); }
        catch { onChange({ date: text || undefined, dateJulian: value ? text : undefined, dateByzantine: undefined }); }
      }} />
    <ByzantineDateControl text={text} label={`${label} по византийской эре`}
      checked={byzantine} disabled={disabled} onChange={(value) => {
        try { onChange({ ...normalizeCalendarDate(text, undefined, value ? text : undefined),
          ...(!value ? { dateByzantine: undefined } : {}) }); }
        catch { onChange({ date: text || undefined, dateJulian: undefined, dateByzantine: value ? text : undefined }); }
      }} />
  </div>;
}
