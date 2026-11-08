import { dateInputLabel } from "../domain/dates";
import { canUseOldStyleDate, normalizeLifeDate } from "../domain/calendar-dates";

export function CalendarStyleControl({
  text,
  label,
  checked,
  onChange,
}: {
  text: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (!canUseOldStyleDate(text)) return null;
  let hint = "";
  if (checked && text.trim()) {
    try {
      const value = normalizeLifeDate(text, true);
      hint =
        value.julian?.length === 10
          ? `Новый стиль: ${dateInputLabel(value.date)}`
          : "Для точного пересчёта укажите день и месяц.";
    } catch {
      /* The date field reports validation errors on blur/save. */
    }
  }
  return (
    <div className="calendar-style-control">
      <label className="check-field">
        <input
          type="checkbox"
          checked={checked}
          aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
        />
        Юлианский календарь (старый стиль)
      </label>
      <small role="status">{hint || (Number(text.match(/\\d{4}/)?.[0]) < 1700
        ? "Календарь выбирается вручную. Даты «от Сотворения мира» используют другую нумерацию лет." : "")}</small>
    </div>
  );
}
