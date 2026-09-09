import { Medal, Plus, Trash2, ChevronDown, ArrowUpRight } from "lucide-react";
import type { PersonAward } from "../domain/types";
import { safeUrl } from "../domain";

export function AwardsEditor({
  awards,
  onChange,
}: {
  awards: PersonAward[];
  onChange: (awards: PersonAward[]) => void;
}) {
  function update(id: string, patch: Partial<PersonAward>) {
    onChange(awards.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }
  return (
    <details className="form-details award-editor">
      <summary>Награды{awards.length ? ` · ${awards.length}` : ""}</summary>
      {awards.map((award, i) => (
        <fieldset key={award.id}>
          <legend>Награда {i + 1}</legend>
          <div className="award-name-year">
            <label>
              Название
              <input
                value={award.name}
                maxLength={300}
                placeholder="Например, медаль «За отвагу»"
                onChange={(e) => update(award.id, { name: e.target.value })}
              />
            </label>
            <label>
              Год
              <input
                value={award.year || ""}
                inputMode="numeric"
                maxLength={4}
                placeholder="1945"
                onChange={(e) =>
                  update(award.id, { year: e.target.value || undefined })
                }
              />
            </label>
          </div>
          <label>
            Источник
            <input
              value={award.source?.title || ""}
              maxLength={2000}
              placeholder="Наградной лист, архивный шифр, семейное свидетельство…"
              onChange={(e) =>
                update(award.id, {
                  source:
                    e.target.value || award.source?.url
                      ? { ...award.source, title: e.target.value }
                      : undefined,
                })
              }
            />
          </label>
          <label>
            Ссылка на источник, если есть
            <input
              value={award.source?.url || ""}
              maxLength={2048}
              placeholder="https://…"
              onChange={(e) =>
                update(award.id, {
                  source:
                    e.target.value || award.source?.title
                      ? {
                          title: award.source?.title || "",
                          url: e.target.value.trim() || undefined,
                        }
                      : undefined,
                })
              }
            />
          </label>
          <button
            type="button"
            className="award-remove"
            onClick={() => onChange(awards.filter((a) => a.id !== award.id))}
          >
            <Trash2 size={14} /> Убрать награду
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="award-add"
        disabled={awards.length >= 100}
        onClick={() =>
          onChange([...awards, { id: crypto.randomUUID(), name: "" }])
        }
      >
        <Plus size={15} /> Добавить награду
      </button>
    </details>
  );
}

export function PersonAwards({ awards }: { awards?: PersonAward[] }) {
  if (!awards?.length) return null;
  return (
    <section className="person-awards" aria-label="Награды человека">
      <h3>Награды</h3>
      <ul>
        {awards.map((award) => {
          const url = safeUrl(award.source?.url);
          const hasSource = !!(award.source?.title || url);
          const label = (
            <>
              <span className="award-badge" aria-hidden="true">
                <Medal size={26} strokeWidth={1.4} />
              </span>
              <span className="award-label">
                <strong>{award.name}</strong>
                {award.year && <small>{award.year}</small>}
              </span>
            </>
          );
          return (
            <li key={award.id}>
              {hasSource ? (
                <details className="award-card">
                  <summary>
                    {label}
                    <ChevronDown size={14} className="award-chevron" />
                  </summary>
                  <div className="award-source">
                    {award.source?.title && <p>{award.source.title}</p>}
                    {url && (
                      <a href={url} target="_blank" rel="noopener noreferrer">
                        Открыть источник <ArrowUpRight size={13} />
                      </a>
                    )}
                  </div>
                </details>
              ) : (
                <div className="award-card award-static">{label}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
