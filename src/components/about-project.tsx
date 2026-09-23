import { TreeDeciduous, BookOpen, Users } from "lucide-react";
import { EditorDialog } from "./editor-dialog";

export function AboutProject({ onClose }: { onClose: () => void }) {
  return (
    <EditorDialog title="О проекте" onClose={onClose}>
      <div className="about-story">
        <TreeDeciduous size={30} strokeWidth={1.5} aria-hidden="true" />
        <h2>Drevo</h2>
        <p>
          Это мой пет-проект для семейной истории. Я собираю здесь людей,
          родственные связи, фотографии и документы, чтобы не терять их по
          разным папкам и записям.
        </p>
        <div className="about-instructions">
          <div>
            <TreeDeciduous size={18} aria-hidden="true" />
            <span>
              <b>Древо и хронология</b>
              <p>Показывают связи между людьми и известные годы их жизни.</p>
            </span>
          </div>
          <div>
            <BookOpen size={18} aria-hidden="true" />
            <span>
              <b>Карточки и фотографии</b>
              <p>Даты, места, воспоминания, источники и семейные снимки.</p>
            </span>
          </div>
          <div>
            <Users size={18} aria-hidden="true" />
            <span>
              <b>Проверка родства</b>
              <p>Выберите двух людей, чтобы увидеть связь между ними.</p>
            </span>
          </div>
        </div>
        <button type="button" className="dialog-done" onClick={onClose}>
          Вернуться в архив
        </button>
      </div>
    </EditorDialog>
  );
}
