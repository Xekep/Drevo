import { EditorDialog } from "./editor-dialog";
import { fullName, type ChangeConflict, type Family } from "../domain";
const names: Record<string, string> = {
  birth: "Дата рождения",
  death: "Дата смерти",
  name: "Имя",
  surname: "Фамилия",
  patronymic: "Отчество",
  biography: "История",
  awards: "Награды",
  parents: "Родители",
  spouses: "Супруги",
  note: "Примечание",
  photo: "Портрет",
  sex: "Пол",
  title: "Название",
  description: "Описание",
  birthPlace: "Место рождения",
  deathPlace: "Место смерти",
};
export function ConflictDialog({
  conflict,
  family,
}: {
  conflict: {
    fields: ChangeConflict[];
    resolve: (choice: "local" | "remote" | "cancel") => void;
  };
  family: Family;
}) {
  const label = (id?: string) => {
    const person = family.people.find((p) => p.id === id);
    return person ? fullName(person) : "Запись архива";
  };
  const text = (value: unknown) =>
    value === undefined
      ? "Не указано / удалено"
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2);
  return (
    <EditorDialog
      title="Эти сведения изменились"
      onClose={() => conflict.resolve("cancel")}
    >
      <div className="archive-form">
        <p>
          Другой участник изменил те же поля. Ваш черновик сохранён. Независимые
          правки будут объединены; выберите вариант для совпавших полей.
        </p>
        {conflict.fields.map(({ change, current }, i) => (
          <section className="conflict-field" key={i}>
            <h3>
              {label(change.id)} ·{" "}
              {names[change.field || ""] || change.field || "Карточка"}
            </h3>
            <span>В архиве сейчас</span>
            <pre>{text(current)}</pre>
            <span>Ваш вариант</span>
            <pre>{text(change.after)}</pre>
          </section>
        ))}
        <footer>
          <button
            className="primary-action"
            onClick={() => conflict.resolve("local")}
          >
            Сохранить мои варианты
          </button>
          <button onClick={() => conflict.resolve("remote")}>
            Принять варианты из архива
          </button>
          <button onClick={() => conflict.resolve("cancel")}>
            Вернуться к черновику
          </button>
        </footer>
      </div>
    </EditorDialog>
  );
}
