import {
  SIBLING_LINK_TYPES,
  SIBLING_NAMES,
  type SiblingLinkType,
} from "../domain";

export function SiblingTypeField({
  value,
  onChange,
  disabled = false,
}: {
  value: SiblingLinkType;
  onChange: (type: SiblingLinkType) => void;
  disabled?: boolean;
}) {
  return (
    <label>
      Какое родство известно
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as SiblingLinkType)}
      >
        {SIBLING_LINK_TYPES.map((type) => (
          <option key={type} value={type}>
            {SIBLING_NAMES[type]}
          </option>
        ))}
      </select>
      <small>
        Можно записать без родителей. Уточняйте тип только по известным
        сведениям. Если родители уже указаны, родство также рассчитывается
        автоматически.
      </small>
    </label>
  );
}
