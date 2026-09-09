import {
  TreeDeciduous,
  BookOpen,
  Users,
  Heart,
  ArrowRight,
} from "lucide-react";
import { EditorDialog } from "./editor-dialog";
import { ArchiveSummary } from "./archive-summary";
import type { Person } from "../domain";

export function AboutProject({
  onClose,
  people,
}: {
  onClose: () => void;
  people?: Person[];
}) {
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
        {people && (
          <section
            className="about-archive"
            aria-label="Семейный архив в цифрах"
          >
            <h3>Наша история в цифрах</h3>
            <ArchiveSummary people={people} detailed />
            {!!people.length && (
              <p>По известным датам жизни и связям между поколениями.</p>
            )}
          </section>
        )}
        <div className="about-demo">
          <Heart size={16} />
          <p>
            Семейная история составлена из сведений и связей, добавленных в
            архив.
          </p>
        </div>
        <button className="dialog-done" onClick={onClose}>
          Перейти к истории <ArrowRight size={15} />
        </button>
        <p className="about-credit">
          3D-голубь:{" "}
          <a
            href="https://sketchfab.com/3d-models/animated-bird-pigeon-797d27b68af3453e865149435df6aa30"
            target="_blank"
            rel="noreferrer"
          >
            Paul Spooner
          </a>
          ,{" "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
          >
            CC BY 4.0
          </a>
          . Цвет и анимация адаптированы для «Древа».
        </p>
      </div>
    </EditorDialog>
  );
}
