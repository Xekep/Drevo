import { useRef, useState } from "react";
import type { PlaceLocation } from "../domain/types";
import type { PlaceResult } from "../domain/places";

export function PlaceField({
  label,
  value,
  onChange,
  onLocation,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onLocation?: (location: PlaceLocation) => void;
  maxLength?: number;
}) {
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  async function locate() {
    if (value.trim().length < 2) return;
    const request = ++sequence.current;
    setNotice("Ищем место на карте…");
    try {
      const response = await fetch(
        `/api/places/locate?q=${encodeURIComponent(value.trim())}`,
        { headers: { "X-Drevo-Map": "1" } },
      );
      if (!response.ok) throw new Error();
      const result: PlaceResult = await response.json();
      if (request !== sequence.current) return;
      if (result.automatic) {
        onLocation?.({ place: value.trim(), ...result.automatic });
        setNotice(
          `На карте: ${result.automatic.label}. Историческое название сохранится.`,
        );
      } else
        setNotice(
          result.candidates.length
            ? "Есть несколько вариантов. Уточните область или выберите точку в разделе «Места»."
            : "Название сохранится. Точку можно уточнить в разделе «Места».",
        );
    } catch {
      if (request === sequence.current)
        setNotice(
          "Поиск сейчас недоступен. Название можно сохранить без координат.",
        );
    }
  }
  return (
    <label>
      {label}
      <input
        value={value}
        maxLength={maxLength}
        placeholder="Название в то время"
        onChange={(e) => {
          sequence.current++;
          setNotice("");
          onChange(e.target.value);
        }}
        onBlur={() => void locate()}
      />
      <small className="place-input-notice" role="status" hidden={!notice}>
        {notice}
      </small>
    </label>
  );
}
