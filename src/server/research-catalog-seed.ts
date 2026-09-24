export const researchCatalogSeed: Array<{
  name: string;
  resources: Array<{ name: string; url: string; description: string }>;
}> = [
  {
    name: "Архивы",
    resources: [
      {
        name: "Яндекс Архивы",
        url: "https://yandex.ru/archive",
        description:
          "метрические книги, ревизские сказки, переписи, старые документы.",
      },
      {
        name: "Архивы России",
        url: "https://portal.rusarchives.ru",
        description: "поиск нужного федерального или регионального архива.",
      },
      {
        name: "ГИС УИАД",
        url: "https://online.archives.ru",
        description: "каталоги и оцифрованные дела федеральных архивов.",
      },
      {
        name: "FamilySearch",
        url: "https://www.familysearch.org",
        description:
          "метрические книги, актовые записи и зарубежные источники.",
      },
      {
        name: "Центральный фондовый каталог",
        url: "https://cfc.rusarchives.ru",
        description: "поиск архивных фондов по всей России.",
      },
      {
        name: "РГАДА",
        url: "https://rgada.info",
        description:
          "ревизии, переписные книги и другие документы XVIII–XIX веков.",
      },
      {
        name: "РГИА",
        url: "https://rgia.su",
        description:
          "документы Российской империи: чиновники, духовенство, учреждения, учебные заведения.",
      },
      {
        name: "ГАРФ",
        url: "https://statearchive.ru",
        description: "документы Российской империи, РСФСР и СССР.",
      },
    ],
  },
  {
    name: "Война",
    resources: [
      {
        name: "Память народа",
        url: "https://pamyat-naroda.ru",
        description: "участники ВОВ, награды, части и боевой путь.",
      },
      {
        name: "ОБД Мемориал",
        url: "https://obd-memorial.ru",
        description:
          "погибшие, пропавшие без вести, пленные и воинские захоронения.",
      },
      {
        name: "Подвиг народа",
        url: "https://podvignaroda.ru",
        description: "наградные документы участников ВОВ.",
      },
      {
        name: "Первая мировая 1914–1918",
        url: "https://gwar.mil.ru",
        description: "военнослужащие Российской империи.",
      },
      {
        name: "РГВИА",
        url: "https://rgvia.com",
        description: "документы русской армии до 1918 года.",
      },
      {
        name: "РГВА",
        url: "https://rgvarchive.ru",
        description: "Красная армия, войска НКВД и документы XX века.",
      },
      {
        name: "РГАВМФ",
        url: "https://rgavmf.ru",
        description: "документы по службе во флоте.",
      },
    ],
  },
  {
    name: "Репрессии",
    resources: [
      {
        name: "Открытый список",
        url: "https://ru.openlist.wiki",
        description: "репрессированные, аресты, приговоры и реабилитации.",
      },
      {
        name: "Мемориал",
        url: "https://base.memo.ru",
        description: "жертвы политического террора в СССР.",
      },
      {
        name: "Рассекреченные документы Росархива",
        url: "https://unsecret.rusarchives.ru",
        description: "сведения о рассекреченных архивных делах.",
      },
    ],
  },
  {
    name: "Захоронения",
    resources: [
      {
        name: "Помним.Online",
        url: "https://pomnim.online/search",
        description:
          "крупная общероссийская база захоронений, фото и координаты.",
      },
      {
        name: "Zahoron.ru",
        url: "https://zahoron.ru",
        description: "межрегиональная база захоронений по России.",
      },
      {
        name: "Свеча",
        url: "https://poisk.sveca.ru",
        description: "поиск по региону, городу, кладбищу и ФИО.",
      },
      {
        name: "Нить поколений",
        url: "https://nit-pokoleniy.ru",
        description: "захоронения, кладбища, фотографии и координаты.",
      },
      {
        name: "ПомниМап",
        url: "https://www.pomnimap.ru/poisk-zahoroneniy",
        description: "общероссийская карта кладбищ и могил.",
      },
      {
        name: "Я помню",
        url: "https://yapomny.ru",
        description: "база захоронений с координатами.",
      },
      {
        name: "Национальная Память",
        url: "https://национальнаяпамять.рф",
        description: "поиск по ФИО, месту и датам жизни.",
      },
      {
        name: "Мемориал — карта захоронений",
        url: "https://memorial-map.ru",
        description: "цифровые кладбища и карты захоронений.",
      },
      {
        name: "iWALY",
        url: "https://iwaly.ru",
        description:
          "каталог кладбищ и пользовательские записи о захоронениях.",
      },
      {
        name: "Find a Grave",
        url: "https://www.findagrave.com",
        description: "международная пользовательская база могил, есть Россия.",
      },
      {
        name: "BillionGraves",
        url: "https://billiongraves.com",
        description: "фотографии надгробий и GPS-координаты, есть Россия.",
      },
      {
        name: "MillionGraves",
        url: "https://memo.uolega.ru",
        description: "крупная база Москвы, Московской и Тверской областей.",
      },
      {
        name: "Ритуал-Архив",
        url: "https://ritual-archive.ru/#search",
        description: "большая база кладбищ Свердловской области.",
      },
      {
        name: "Кладбища Каменска-Уральского",
        url: "https://cemetery.kamensk-uralskiy.ru/search",
        description: "городской поиск захоронений.",
      },
      {
        name: "Поиск захоронений Нижнего Тагила",
        url: "https://p-z-nt.ru/search",
        description: "кладбища, участки и координаты.",
      },
      {
        name: "Skorbim",
        url: "http://skorbim.com",
        description: "захоронения Режа и Режевского района.",
      },
      {
        name: "SPoK45",
        url: "https://spok45.ru",
        description: "Курган и Курганская область.",
      },
      {
        name: "Поиск захоронений Магнитогорска",
        url: "https://evroservis.ooo/burial-search",
        description: "городские кладбища Магнитогорска.",
      },
      {
        name: "Помним.me",
        url: "https://pomnim.me",
        description: "кладбища Уфы.",
      },
      {
        name: "Кладбище Сибая",
        url: "https://www.кладбище-в-сибае.рф",
        description: "база захоронений Сибая.",
      },
      {
        name: "Кладбища Казани",
        url: "https://cemetery.kzn.ru/search",
        description: "официальный городской поиск захоронений.",
      },
      {
        name: "Ritual116",
        url: "https://ritual116.ru",
        description: "захоронения Набережных Челнов.",
      },
      {
        name: "Кладбища Нижнего Новгорода",
        url: "https://munkl-nn.ru/search",
        description: "официальный муниципальный поиск.",
      },
      {
        name: "Кладбища Ярославля",
        url: "https://sgk76.ru/poisk-zahoronenij",
        description: "поиск по городским кладбищам.",
      },
      {
        name: "Кладбища Новосибирска",
        url: "https://map.novo-sibirsk.ru/portal/ritual",
        description: "официальный поиск с картой и маршрутами.",
      },
      {
        name: "MemoryTmb",
        url: "https://memorytmb.ru",
        description: "цифровые кладбища Тамбова.",
      },
      {
        name: "ГИС «Память» Самары",
        url: "http://samara.gispam.ru:444/public",
        description: "ФИО, фотографии и координаты захоронений.",
      },
      {
        name: "Карта памяти 22",
        url: "http://www.карта-памяти22.рф",
        description: "захоронения Барнаула и Алтайского края.",
      },
      {
        name: "Чтобы помнить",
        url: "https://чтобыпомнить.рф",
        description: "виртуальные кладбища Красноярского края.",
      },
      {
        name: "ПримРитуалСервис",
        url: "https://примритуалсервис.рф",
        description: "захоронения Приморского края.",
      },
      {
        name: "JEKL",
        url: "https://jekl.ru",
        description:
          "еврейские захоронения Санкт-Петербурга и Ленинградской области.",
      },
      {
        name: "Смоленское лютеранское кладбище",
        url: "https://spslc.ru",
        description:
          "специализированный электронный некрополь Санкт-Петербурга.",
      },
      {
        name: "Виртуальный некрополь Севастополя",
        url: "https://www.tombs-sevastopol.ru",
        description: "кладбища и военные захоронения Севастополя.",
      },
      {
        name: "Кладбища Ялты",
        url: "https://ritual-yalta.ru",
        description: "поиск захоронений Ялты.",
      },
      {
        name: "Кладбище Мичуринска",
        url: "https://мичуринск-наукоград.рф/actual/blagoustroistvo/ritual/map",
        description: "электронный реестр городского кладбища.",
      },
      {
        name: "Новодевичий некрополь",
        url: "https://www.nd.m-necropol.ru",
        description: "захоронения известных людей на Новодевичьем кладбище.",
      },
    ],
  },
  {
    name: "Старые книги и газеты",
    resources: [
      {
        name: "НЭБ",
        url: "https://rusneb.ru",
        description: "книги, газеты, справочники и краеведческие издания.",
      },
      {
        name: "Президентская библиотека",
        url: "https://www.prlib.ru",
        description: "адрес-календари, памятные книжки, карты и справочники.",
      },
      {
        name: "Российская государственная библиотека",
        url: "https://www.rsl.ru",
        description: "книги, периодика, рукописи и старые издания.",
      },
      {
        name: "Российская национальная библиотека",
        url: "https://nlr.ru",
        description: "газеты, книги, справочники и краеведческие материалы.",
      },
    ],
  },
  {
    name: "Карты",
    resources: [
      {
        name: "ЭтоМесто",
        url: "https://www.etomesto.ru",
        description: "старые карты и исчезнувшие населённые пункты.",
      },
      {
        name: "Retromap",
        url: "https://retromap.ru",
        description: "сравнение исторических карт.",
      },
    ],
  },
  {
    name: "Эмиграция и перемещённые лица",
    resources: [
      {
        name: "Arolsen Archives",
        url: "https://collections.arolsen-archives.org",
        description:
          "узники лагерей, остарбайтеры, перемещённые лица и документы Второй мировой войны.",
      },
      {
        name: "FamilySearch",
        url: "https://www.familysearch.org",
        description:
          "зарубежные переписи, миграционные записи и документы эмигрантов.",
      },
    ],
  },
  {
    name: "Помощь с поиском",
    resources: [
      {
        name: "ВГД",
        url: "https://forum.vgd.ru",
        description: "крупнейший русскоязычный генеалогический форум.",
      },
    ],
  },
];
