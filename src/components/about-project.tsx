import { TreeDeciduous, BookOpen, Users } from "lucide-react";
import { EditorDialog } from "./editor-dialog";

export function AboutProject({ onClose }: { onClose: () => void }) {
  return (
    <EditorDialog title="О проекте" onClose={onClose}>
      <div className="about-story">
        <p className="about-lead">
          Drevo — мой пет-проект для создания и хранения семейного древа.
        </p>
        <p>
          Я начал делать его для своей семьи, потому что хотелось собрать в одном
          месте родственников, фотографии, документы, семейные связи и другую
          информацию, которая обычно разбросана по разным людям и архивам.
        </p>
        <p>
          Проект пока развивается: я постепенно добавляю новые возможности и
          одновременно наполняю собственное семейное древо.
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
