import { useState } from "react";
import { validateFamily, type Family } from "../domain";
import { EditorDialog } from "./editor-dialog";
export function ArchiveSettings({
  family,
  save,
  busy,
  onClose,
}: {
  family: Family;
  save: (f: Family) => Promise<Family>;
  busy: boolean;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(family.title),
    [description, setDescription] = useState(family.description),
    [demo, setDemo] = useState(family.demo),
    [error, setError] = useState(""),
    [imported, setImported] = useState<Family | null>(null),
    [clear, setClear] = useState(false);
  async function persist(data: Family) {
    try {
      await save(data);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <EditorDialog title="Настройки архива" onClose={onClose}>
      <form
        className="archive-form"
        onSubmit={(e) => {
          e.preventDefault();
          void persist({ ...family, title, description, demo });
        }}
      >
        <label>
          Название
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Описание
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={demo}
            onChange={(e) => setDemo(e.target.checked)}
          />{" "}
          Это демонстрационная семья
        </label>
        <button disabled={busy} className="primary-action">
          Сохранить настройки
        </button>
        <section>
          <h3>Импорт JSON</h3>
          <p>
            Заменяет людей и связи текущего архива. Сначала скачайте бэкап.
            Файлы фотографий переносятся отдельно.
          </p>
          <label>
            Выберите экспорт архива
            <input
              type="file"
              accept=".json,application/json"
              onChange={async (e) => {
                setError("");
                setImported(null);
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  if (file.size > 8 * 1024 * 1024)
                    throw new Error("Архив превышает 8 МБ");
                  setImported(validateFamily(JSON.parse(await file.text())));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          </label>
          {imported && (
            <>
              <p>
                «{imported.title}»: {imported.people.length} человек,{" "}
                {imported.photos?.length || 0} фотографий.
              </p>
              <button
                disabled={busy}
                type="button"
                onClick={() => void persist(imported)}
              >
                Заменить архив этими данными
              </button>
            </>
          )}
        </section>
        {family.demo && (
          <section>
            <h3>Начать свою историю</h3>
            <p>
              Убрать демонстрационных людей и начать пустое древо. Сначала
              сохраните нужные данные.
            </p>
            <button
              type="button"
              className="danger-action"
              disabled={busy}
              onClick={() => {
                if (!clear) {
                  setClear(true);
                  return;
                }
                void persist({
                  title: "Семейный архив",
                  description: "История нашей семьи",
                  demo: false,
                  people: [],
                  links: [],
                  photos: [],
                });
              }}
            >
              {clear
                ? "Подтвердить очистку демонстрационного архива"
                : "Начать пустое древо"}
            </button>
          </section>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </EditorDialog>
  );
}
