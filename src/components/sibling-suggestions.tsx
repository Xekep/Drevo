import { fullName, resolvedSex, type SiblingHint } from "../domain";
import { directoryYears } from "../domain/people-directory";

export function SiblingSuggestions({
  hints,
  onParents,
  busy = false,
}: {
  hints: SiblingHint[];
  onParents?: (hint: SiblingHint) => void;
  busy?: boolean;
}) {
  if (!hints.length) return null;
  return (
    <details className="name-suggestions">
      <summary>Возможные братья и сёстры · {hints.length}</summary>
      <p>
        Совпадение ФИО — повод проверить сведения. Подтвердите общих родителей:
        вид родства определится автоматически.
      </p>
      {hints.map((hint) => (
        <details key={hint.person.id} className="sibling-candidate">
          <summary>
            {resolvedSex(hint.person) === "m"
              ? "Возможный брат"
              : resolvedSex(hint.person) === "f"
                ? "Возможная сестра"
                : "Возможный брат или сестра"}
            : {fullName(hint.person)}
            <small>{directoryYears(hint.person)}</small>
          </summary>
          <p>{hint.reason}</p>
          {onParents ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onParents(hint)}
            >
              Уточнить общего родителя
            </button>
          ) : (
            <p>
              Если нужный родитель предложен выше, подтвердите его. Иначе после
              сохранения добавьте связь с известным общим родителем из карточки
              человека.
            </p>
          )}
        </details>
      ))}
      <p>
        Не родственники? Оставьте подсказку без подтверждения — связь не
        появится.
      </p>
    </details>
  );
}
