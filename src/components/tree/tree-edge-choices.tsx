import type { RefObject } from "react";
import { X } from "lucide-react";
import { fullName, type GraphConnection, type Person } from "../../domain/index.ts";

export function TreeEdgeChoices({
  choices,
  peopleMap,
  connections,
  closeRef,
  onClose,
  onSelect,
}: {
  choices: GraphConnection[];
  peopleMap: Map<string, Person>;
  connections: GraphConnection[];
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSelect: (edge: GraphConnection) => void;
}) {
  if (!choices.length) return null;
  return (
    <div
      className="tree-edge-choices"
      role="dialog"
      aria-label="Связи семейной ветки"
    >
      <div>
        <strong>Связи этой ветки</strong>
        <button aria-label="Закрыть выбор связи" ref={closeRef} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <p>Выберите связь, чтобы открыть её сведения.</p>
      {choices
        .filter(
          (edge) =>
            peopleMap.has(edge.from) &&
            peopleMap.has(edge.to) &&
            connections.some((connection) => connection.key === edge.key),
        )
        .map((edge) => (
          <button
            key={edge.key}
            onClick={() => {
              onClose();
              onSelect(edge);
            }}
          >
            <span>{fullName(peopleMap.get(edge.from)!)}</span>
            <small>Родитель → {fullName(peopleMap.get(edge.to)!)}</small>
          </button>
        ))}
    </div>
  );
}
