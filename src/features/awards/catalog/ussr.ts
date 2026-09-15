import type { AwardDefinition, AwardImage } from "../types.ts";

const commons = (file: string, sourcePage: string, license: string, author?: string): AwardImage => ({
  src: `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(file)}`,
  sourcePage,
  license,
  author,
});

const pending = {
  imageStatus: "pending-license-review" as const,
  country: "USSR",
  countryName: "СССР",
  level: "state" as const,
};

const order = (
  id: string,
  name: string,
  establishedAt: string,
  tags: string[],
  extra: Partial<AwardDefinition> = {},
): AwardDefinition => ({
  id,
  name,
  kind: "order",
  establishedAt,
  tags,
  description: `Государственная награда СССР: ${name}.`,
  ...pending,
  ...extra,
});

const medal = (
  id: string,
  name: string,
  establishedAt: string,
  tags: string[],
  extra: Partial<AwardDefinition> = {},
): AwardDefinition => ({
  id,
  name,
  kind: "medal",
  establishedAt,
  tags,
  description: `Государственная награда СССР: ${name}.`,
  ...pending,
  ...extra,
});

const degree123 = [
  { id: "1", label: "I степень", aliases: ["1 степень", "первой степени"] },
  { id: "2", label: "II степень", aliases: ["2 степень", "второй степени"] },
  { id: "3", label: "III степень", aliases: ["3 степень", "третьей степени"] },
];

export const USSR_AWARDS: AwardDefinition[] = [
  order("ussr-order-red-star", "Орден Красной Звезды", "1930-04-06", ["ВОВ", "военный"], {
    imageStatus: "verified",
    image: commons(
      "Order of the Red Star.svg",
      "https://commons.wikimedia.org/wiki/File:Order_of_the_Red_Star.svg",
      "PD-RU-exempt",
      "Leonid",
    ),
  }),
  order("ussr-order-patriotic-war", "Орден Отечественной войны", "1942-05-20", ["ВОВ", "военный"], {
    degrees: degree123.slice(0, 2),
    aliases: ["Орден Отечественной войны I степени", "Орден Отечественной войны II степени"],
    imageStatus: "verified",
    image: commons(
      "Order of the Patriotic War (1st class).png",
      "https://commons.wikimedia.org/wiki/File:Order_of_the_Patriotic_War_(1st_class).png",
      "PD-RU-exempt",
    ),
  }),
  order("ussr-order-glory", "Орден Славы", "1943-11-08", ["ВОВ", "военный"], {
    degrees: degree123,
    aliases: ["Орден Славы I степени", "Орден Славы II степени", "Орден Славы III степени"],
  }),
  order("ussr-order-red-banner", "Орден Красного Знамени", "1918-09-16", ["военный"]),
  order("ussr-order-lenin", "Орден Ленина", "1930-04-06", ["высшая награда", "труд", "военный"]),
  order("ussr-order-labour-red-banner", "Орден Трудового Красного Знамени", "1928-09-07", ["труд", "промышленность", "наука"]),
  order("ussr-order-badge-of-honour", "Орден «Знак Почёта»", "1935-11-25", ["труд", "гражданская"]),
  order("ussr-order-labour-glory", "Орден Трудовой Славы", "1974-01-18", ["труд", "промышленность"], { degrees: degree123 }),

  medal("ussr-medal-for-courage", "Медаль «За отвагу»", "1938-10-17", ["ВОВ", "военный"], {
    aliases: ["За отвагу"],
  }),
  medal("ussr-medal-for-combat-service", "Медаль «За боевые заслуги»", "1938-10-17", ["ВОВ", "военный"], {
    aliases: ["За боевые заслуги"],
  }),
  medal("ussr-medal-defense-moscow", "Медаль «За оборону Москвы»", "1944-05-01", ["ВОВ", "оборона"], {
    aliases: ["За оборону Москвы"],
    imageStatus: "verified",
    image: commons(
      "Medal Moskva USSR.jpg",
      "https://commons.wikimedia.org/wiki/File:Medal_Moskva_USSR.jpg",
      "CC BY-SA 2.5",
      "Grzegorz Chladek",
    ),
  }),
  medal("ussr-medal-defense-leningrad", "Медаль «За оборону Ленинграда»", "1942-12-22", ["ВОВ", "оборона"]),
  medal("ussr-medal-defense-stalingrad", "Медаль «За оборону Сталинграда»", "1942-12-22", ["ВОВ", "оборона"]),
  medal("ussr-medal-defense-caucasus", "Медаль «За оборону Кавказа»", "1944-05-01", ["ВОВ", "оборона"]),
  medal("ussr-medal-defense-sevastopol", "Медаль «За оборону Севастополя»", "1942-12-22", ["ВОВ", "оборона"]),
  medal("ussr-medal-defense-odessa", "Медаль «За оборону Одессы»", "1942-12-22", ["ВОВ", "оборона"]),
  medal("ussr-medal-defense-soviet-transarctic", "Медаль «За оборону Советского Заполярья»", "1944-12-05", ["ВОВ", "оборона"]),
  medal("ussr-medal-capture-berlin", "Медаль «За взятие Берлина»", "1945-06-09", ["ВОВ", "взятие города"]),
  medal("ussr-medal-capture-konigsberg", "Медаль «За взятие Кёнигсберга»", "1945-06-09", ["ВОВ", "взятие города"], { aliases: ["За взятие Кенигсберга"] }),
  medal("ussr-medal-capture-budapest", "Медаль «За взятие Будапешта»", "1945-06-09", ["ВОВ", "взятие города"]),
  medal("ussr-medal-capture-vienna", "Медаль «За взятие Вены»", "1945-06-09", ["ВОВ", "взятие города"]),
  medal("ussr-medal-liberation-prague", "Медаль «За освобождение Праги»", "1945-06-09", ["ВОВ", "освобождение"]),
  medal("ussr-medal-liberation-warsaw", "Медаль «За освобождение Варшавы»", "1945-06-09", ["ВОВ", "освобождение"]),
  medal("ussr-medal-liberation-belgrade", "Медаль «За освобождение Белграда»", "1945-06-09", ["ВОВ", "освобождение"]),
  medal("ussr-medal-victory-germany", "Медаль «За победу над Германией в Великой Отечественной войне 1941–1945 гг.»", "1945-05-09", ["ВОВ", "победа"], {
    aliases: ["За победу над Германией", "Медаль за победу над Германией 1941-1945"],
  }),
  medal("ussr-medal-victory-japan", "Медаль «За победу над Японией»", "1945-09-30", ["Вторая мировая", "Япония", "победа"]),
  {
    id: "ussr-gold-star",
    name: "Медаль «Золотая Звезда»",
    kind: "title",
    establishedAt: "1939-08-01",
    tags: ["Герой Советского Союза", "высшая награда"],
    aliases: ["Золотая Звезда Героя Советского Союза", "Герой Советского Союза"],
    description: "Знак особого отличия Героя Советского Союза.",
    ...pending,
  },

  medal("ussr-medal-labor-valour", "Медаль «За трудовую доблесть»", "1938-12-27", ["труд", "промышленность", "наука"]),
  medal("ussr-medal-labor-distinction", "Медаль «За трудовое отличие»", "1938-12-27", ["труд", "промышленность", "наука"]),
  medal("ussr-medal-labor-in-great-patriotic-war", "Медаль «За доблестный труд в Великой Отечественной войне 1941–1945 гг.»", "1945-06-06", ["труд", "ВОВ", "труженик тыла"], { aliases: ["За доблестный труд в ВОВ", "За доблестный труд 1941-1945"] }),
  medal("ussr-medal-veteran-labour", "Медаль «Ветеран труда»", "1974-01-18", ["труд", "ветеран", "стаж"], {
    aliases: ["Ветеран труда"],
    imageStatus: "verified",
    image: commons(
      "VeteranOfLabourMedal3.jpg",
      "https://commons.wikimedia.org/wiki/File:VeteranOfLabourMedal3.jpg",
      "Public domain",
      "Man22",
    ),
  }),
  medal("ussr-medal-restoration-donbass-coal-mines", "Медаль «За восстановление угольных шахт Донбасса»", "1947-09-10", ["труд", "шахты", "восстановление"]),
  medal("ussr-medal-restoration-ferrous-metallurgy", "Медаль «За восстановление предприятий чёрной металлургии Юга»", "1948-05-18", ["труд", "металлургия", "восстановление"]),
  medal("ussr-medal-virgin-lands", "Медаль «За освоение целинных земель»", "1956-10-20", ["труд", "сельское хозяйство", "целина"]),
  medal("ussr-medal-baikal-amur-mainline", "Медаль «За строительство Байкало-Амурской магистрали»", "1976-10-08", ["труд", "строительство", "БАМ", "железная дорога"], { aliases: ["За строительство БАМ", "Медаль БАМ"] }),
  medal("ussr-medal-non-black-earth-development", "Медаль «За преобразование Нечерноземья РСФСР»", "1977-09-30", ["труд", "сельское хозяйство"]),
  medal("ussr-medal-development-west-siberia", "Медаль «За освоение недр и развитие нефтегазового комплекса Западной Сибири»", "1978-07-28", ["труд", "нефть", "газ", "Сибирь"]),

  medal("ussr-jubilee-100-lenin", "Юбилейная медаль «За доблестный труд в ознаменование 100-летия со дня рождения Владимира Ильича Ленина»", "1969-11-05", ["труд", "юбилейная", "Ленин"], { aliases: ["100 лет Ленину за доблестный труд", "Юбилейная медаль 100 лет Ленину"] }),
  medal("ussr-jubilee-20-rkka", "Юбилейная медаль «XX лет Рабоче-Крестьянской Красной Армии»", "1938-01-24", ["юбилейная", "военный", "РККА"], { aliases: ["20 лет РККА", "XX лет РККА"] }),
  medal("ussr-jubilee-30-army-navy", "Юбилейная медаль «30 лет Советской Армии и Флота»", "1948-02-22", ["юбилейная", "военный", "армия", "флот"]),
  medal("ussr-jubilee-40-armed-forces", "Юбилейная медаль «40 лет Вооружённых Сил СССР»", "1957-12-18", ["юбилейная", "военный", "армия"]),
  medal("ussr-jubilee-50-armed-forces", "Юбилейная медаль «50 лет Вооружённых Сил СССР»", "1967-12-26", ["юбилейная", "военный", "армия"]),
  medal("ussr-jubilee-60-armed-forces", "Юбилейная медаль «60 лет Вооружённых Сил СССР»", "1978-01-28", ["юбилейная", "военный", "армия"]),
  medal("ussr-jubilee-70-armed-forces", "Юбилейная медаль «70 лет Вооружённых Сил СССР»", "1988-01-28", ["юбилейная", "военный", "армия"]),
  medal("ussr-jubilee-20-victory", "Юбилейная медаль «Двадцать лет Победы в Великой Отечественной войне 1941–1945 гг.»", "1965-05-07", ["юбилейная", "ВОВ", "победа"], { aliases: ["20 лет Победы в ВОВ", "20 лет Победы"] }),
  medal("ussr-jubilee-30-victory", "Юбилейная медаль «Тридцать лет Победы в Великой Отечественной войне 1941–1945 гг.»", "1975-04-25", ["юбилейная", "ВОВ", "победа"], { aliases: ["30 лет Победы в ВОВ", "30 лет Победы"] }),
  medal("ussr-jubilee-40-victory", "Юбилейная медаль «Сорок лет Победы в Великой Отечественной войне 1941–1945 гг.»", "1985-04-12", ["юбилейная", "ВОВ", "победа"], { aliases: ["40 лет Победы в ВОВ", "40 лет Победы"] }),
  medal("ussr-medal-800-moscow", "Медаль «В память 800-летия Москвы»", "1947-09-20", ["юбилейная", "Москва"]),
  medal("ussr-medal-250-leningrad", "Медаль «В память 250-летия Ленинграда»", "1957-05-16", ["юбилейная", "Ленинград"]),
  medal("ussr-medal-1500-kiev", "Медаль «В память 1500-летия Киева»", "1982-05-10", ["юбилейная", "Киев"]),
];
