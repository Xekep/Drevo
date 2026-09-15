import type { AwardDefinition } from "../types.ts";

const state = { country: "RU", countryName: "Россия", level: "state" as const, imageStatus: "pending-license-review" as const };
const departmental = { country: "RU", countryName: "Россия", level: "departmental" as const, imageStatus: "pending-license-review" as const };

export const RUSSIAN_STATE_AWARDS: AwardDefinition[] = [
  { id: "ru-order-courage", kind: "order", name: "Орден Мужества", establishedAt: "1994-03-02", tags: ["военный", "мужество", "спасение"], description: "Государственная награда Российской Федерации.", ...state },
  { id: "ru-order-honour", kind: "order", name: "Орден Почёта", establishedAt: "1994-03-02", tags: ["труд", "гражданская", "заслуги"], description: "Государственная награда Российской Федерации.", ...state },
  { id: "ru-order-friendship", kind: "order", name: "Орден Дружбы", establishedAt: "1994-03-02", tags: ["гражданская", "международная", "дружба"], description: "Государственная награда Российской Федерации.", ...state },
  { id: "ru-medal-suvorov", kind: "medal", name: "Медаль Суворова", establishedAt: "1994-03-02", tags: ["военный", "сухопутные войска"], description: "Государственная награда Российской Федерации.", ...state },
  { id: "ru-medal-zhukov", kind: "medal", name: "Медаль Жукова", establishedAt: "1994-05-09", tags: ["военный", "ветеран"], description: "Государственная награда Российской Федерации.", ...state },
  { id: "ru-medal-nesterov", kind: "medal", name: "Медаль Нестерова", establishedAt: "1994-03-02", tags: ["военный", "авиация"], description: "Государственная награда Российской Федерации.", ...state },
  { id: "ru-medal-defender-free-russia", kind: "medal", name: "Медаль «Защитнику свободной России»", establishedAt: "1992-07-02", tags: ["государственная", "1991"], description: "Государственная награда Российской Федерации.", ...state },
  { id: "ru-medal-saving-perished", kind: "medal", name: "Медаль «За спасение погибавших»", establishedAt: "1994-03-02", tags: ["спасение", "мужество"], description: "Государственная награда Российской Федерации.", ...state },
  { id: "ru-medal-distinction-state-border", kind: "medal", name: "Медаль «За отличие в охране государственной границы»", establishedAt: "1994-03-02", tags: ["военный", "граница"], description: "Государственная награда Российской Федерации.", ...state },
];

export const RUSSIAN_DEPARTMENTAL_AWARDS: AwardDefinition[] = [
  {
    id: "ru-rosatom-veteran-nuclear-energy-industry",
    kind: "badge",
    name: "Знак отличия в труде «Ветеран атомной энергетики и промышленности»",
    aliases: ["Ветеран атомной промышленности", "Ветеран атомной энергетики и промышленности", "Ветеран атомной отрасли"],
    tags: ["атомная промышленность", "Росатом", "ветеран", "труд"],
    issuer: "Госкорпорация «Росатом»",
    description: "Ведомственный знак отличия в труде атомной отрасли. В семейных источниках часто указывается сокращённо.",
    ...departmental,
  },
  {
    id: "ru-rosatom-merit-nuclear-industry",
    kind: "badge",
    name: "Знак отличия «За заслуги перед атомной отраслью»",
    tags: ["атомная промышленность", "Росатом", "труд"],
    issuer: "Госкорпорация «Росатом»",
    description: "Ведомственная награда атомной отрасли; степень и редакцию следует фиксировать по удостоверению.",
    ...departmental,
  },
  {
    id: "ru-rosatom-radiation-accident-response",
    kind: "badge",
    name: "Знак отличия «За ликвидацию радиационных аварий»",
    tags: ["атомная промышленность", "радиационная авария", "ликвидатор"],
    issuer: "Госкорпорация «Росатом»",
    description: "Ведомственная награда атомной отрасли за участие в ликвидации радиационных аварий.",
    ...departmental,
  },
];
