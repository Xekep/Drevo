import { archiveResourceUrl } from "../domain/archive-context.ts";
import { useState } from "react";
import { Download } from "lucide-react";
import type { Family } from "../domain";
import { ArchiveFileImport } from "./archive-file-import";
import { type GenealogyExportFormat } from "../domain/genealogy-transfer";
export function GedcomTransfer({
  onImported,
  save,
  canEdit,
}: {
  onImported: () => void;
  save: (family: Family) => Promise<Family>;
  canEdit: boolean;
}) {
  const [format, setFormat] = useState<GenealogyExportFormat>("gedzip7");
  return (
    <section className="gedcom-transfer">
      <h2>Экспорт</h2>
      <p>Обмен данными с генеалогическими программами.</p>
      <fieldset className="genealogy-formats" aria-label="Формат экспорта">
        {(
          [
            ["gedcom551", "GEDCOM 5.5.1", "Максимальная совместимость"],
            ["gedcom7", "GEDCOM 7", "Современный стандарт"],
            ["gedzip7", "GEDZIP 7", "GEDCOM + фотографии + документы"],
          ] as const
        ).map(([value, title, description]) => (
          <label
            key={value}
            htmlFor={`export-${value}`}
            aria-label={title}
            className="genealogy-format"
          >
            <input
              id={`export-${value}`}
              type="radio"
              name="genealogy-export"
              value={value}
              checked={format === value}
              onChange={() => setFormat(value)}
            />
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <p>
        GEDCOM и GEDZIP сохраняют текст цитат, а GEDZIP также оригиналы файлов.
        Связи цитат с каталогом источников Drevo не переносятся. Для полного
        переноса между древами Drevo используйте формат .drevo.
      </p>
      <details>
        <summary>Особенности формата</summary>
        <p>
          Название и описание архива записываются в заголовок GEDCOM. Длинные
          значения дополнительно сохраняются в поле Drevo, которое сторонняя
          программа может удалить при повторном экспорте.
        </p>
      </details>
      <a
        className="primary-action"
        href={archiveResourceUrl(`/api/gedcom/export?format=${format}`)}
        download
      >
        <Download size={16} />
        Скачать выбранный формат
      </a>
      <div className="json-export">
        <a
          href={archiveResourceUrl("/api/export.json?download=1")}
          download="drevo-family.json"
        >
          <Download size={16} /> Экспорт JSON без фото
        </a>
        <p>Карточки и связи для анализа; файлы фотографий не включены.</p>
      </div>
      <hr />
      <h2>Импорт</h2>
      <ArchiveFileImport
        save={save}
        canEdit={canEdit}
        onImported={onImported}
      />
    </section>
  );
}
