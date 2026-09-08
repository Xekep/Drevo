import {
  TreeDeciduous,
  BookOpen,
  Users,
  Heart,
  ArrowRight,
} from "lucide-react";
import { EditorDialog } from "./editor-dialog";

export function AboutProject({ onClose }: { onClose: () => void }) {
  return (
    <EditorDialog title="О проекте" onClose={onClose}>
      <div className="about-story">
        <TreeDeciduous size={38} strokeWidth={1.2} />
        <div className="eyebrow">МЕСТО ДЛЯ СЕМЕЙНОЙ ПАМЯТИ</div>
        <h2>
          История начинается
          <br />с семьи<span>.</span>
        </h2>
        <p>«Древо» соединяет людей, события и эпохи в одну семейную историю.</p>
        <div className="about-instructions">
          <div>
            <TreeDeciduous size={18} />
            <span>
              <b>Путешествуйте во времени</b>
              <p>
                Исследуйте поколения в «Древе» или переключитесь на
                «Хронологию»: реальные годы жизни, века и исторические эпохи.
              </p>
            </span>
          </div>
          <div>
            <BookOpen size={18} />
            <span>
              <b>Открывайте истории</b>
              <p>
                Нажмите на человека: откроются даты, места, портрет,
                воспоминания и источники. В фотоальбоме — все снимки, на которых
                он отмечен.
              </p>
            </span>
          </div>
          <div>
            <Users size={18} />
            <span>
              <b>Находите общее</b>
              <p>
                Включите «Родство» и выберите двух людей. Узнайте, кем они
                приходятся друг другу и кто их связывает.
              </p>
            </span>
          </div>
        </div>
        <div className="about-demo">
          <Heart size={16} />
          <p>
            Семейная история составлена из сведений и связей, добавленных в
            архив.
          </p>
        </div>
        <details className="about-gestures">
          <summary>Как пользоваться деревом</summary>
          <p>
            Тяните фон мышью или перемещайте дерево пальцем. Масштаб — кнопками,
            щипком или Ctrl + колесо. Shift + нажатие выбирает второго человека.
            «Ветка» оставляет предков и потомков, стрелка под карточкой
            сворачивает детей.
          </p>
          <p>
            На компьютере можно соединять точки на карточках и править связи
            нажатием на линию. Предложенная связь сохраняется после
            подтверждения. «Отменить» возвращает последнее изменение текущей
            вкладки. На телефоне доступны дерево, истории, родство и фотографии;
            редактирование — с компьютера.
          </p>
        </details>
        <button className="dialog-done" onClick={onClose}>
          Перейти к истории <ArrowRight size={15} />
        </button>
      </div>
    </EditorDialog>
  );
}
