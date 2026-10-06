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
        <p>
          Отдельно хочу отметить моего друга <b>Apakalipses</b>, который
          внёс значительный вклад в его разработку.
        </p>
        <p className="about-signature">
          <a href="https://vk.ru/xekep" target="_blank" rel="noreferrer">
            Евгений С.
          </a>
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
        <details className="about-stack">
          <summary>Как это работает</summary>
          <div className="about-stack-content">
            <p>Основной стек Drevo:</p>
            <ul>
              <li>
                <b>TypeScript</b> — основной язык проекта.
              </li>
              <li>
                <b>React</b> — интерфейс приложения.
              </li>
              <li>
                <b>Node.js</b> — серверная часть.
              </li>
              <li>
                <b>PostgreSQL</b> — хранение данных.
              </li>
              <li>
                <b>React Flow и ELK</b> — отображение и автоматическая раскладка
                семейного древа.
              </li>
              <li>
                <b>Human / TensorFlow.js</b> — нейросетевой анализ фотографий и
                распознавание лиц.
              </li>
              <li>
                <b>Leaflet</b> — отображение мест и семейной географии на карте.
              </li>
              <li>
                <b>Yandex AI Studio</b> — встроенные функции искусственного
                интеллекта.
              </li>
              <li>
                <b>GEDCOM</b> — импорт и экспорт генеалогических данных.
              </li>
            </ul>
          </div>
        </details>
        <button type="button" className="dialog-done" onClick={onClose}>
          Вернуться в архив
        </button>
      </div>
    </EditorDialog>
  );
}
