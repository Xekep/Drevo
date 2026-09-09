import { TreeDeciduous, Heart, ArrowRight } from "lucide-react";
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
      </div>
    </EditorDialog>
  );
}
