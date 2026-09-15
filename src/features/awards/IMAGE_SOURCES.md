# Источники изображений наград

В профиле человека используются локальные прозрачные SVG/PNG из `public/awards/`. Внешние страницы хранятся только как источник происхождения и лицензии: интерфейс не должен зависеть от Wikimedia Commons или фотографий с белой подложкой.

Каталоги разделены по системе наград, а не по русскому названию. Например, СССР хранится в `public/awards/ussr/`, современная Россия — в `public/awards/ru/`, Монголия/МНР — в `public/awards/mn/`. Одинаково называющиеся награды разных государств обязаны иметь разные `awardDefinitionId` и разные файлы.

| Награда | Локальный файл | Основа / источник | Правовой статус источника |
| --- | --- | --- | --- |
| Медаль «За отвагу» (СССР) | `/awards/ussr/medal-for-courage.svg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Medal_of_Valour,_Soviet_Union.png) | PD-RU-exempt |
| Орден Славы III степени (СССР) | `/awards/ussr/order-glory-3.svg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Order_of_Glory_3rd_class.jpg) | CC BY-SA 3.0; локальная SVG-реконструкция |
| Медаль «За победу над Германией…» (СССР) | `/awards/ussr/medal-victory-germany.svg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:WW2_Victory.png) | CC BY-SA 3.0; локальная SVG-реконструкция |
| Медаль «За взятие Кёнигсберга» (СССР) | `/awards/ussr/medal-capture-konigsberg.svg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Capture_of_Koenigsberg_OBVERSE.jpg) | CC BY-SA 3.0; локальная SVG-реконструкция |
| Медаль «За взятие Берлина» (СССР) | `/awards/ussr/medal-capture-berlin.svg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Medal_For_the_Capture_of_Berlin.jpg) | PD-RU-exempt; локальная SVG-реконструкция |
| Медаль «Ветеран труда» (СССР) | `/awards/ussr/medal-veteran-labour.svg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:VeteranOfLabourMedal3.jpg) | дизайн государственной награды СССР; фото-источник CC BY-SA 3.0 |
| «Ветеран атомной энергетики и промышленности» (Россия, Росатом) | `/awards/ru/rosatom/veteran-nuclear-energy-industry.svg` | официальный рисунок и описание ведомственного знака | локальная SVG-реконструкция по нормативному описанию |
| «30 лет Халхин-Гольской Победы» (МНР) | `/awards/mn/medal-30-khalkhin-gol-victory.svg` | Wikimedia Commons / описание награды | PD-Mongolia-exempt; локальная SVG-реконструкция |

Локальная реконструкция не должна добавлять фон, карточку, декоративный круг вокруг самой награды или другие элементы интерфейса. Прозрачность является свойством ассета. Круглая форма самой медали, разумеется, остаётся частью награды.

Перед добавлением нового визуала нужно проверить конкретную систему наград, страну, степень/класс и источник. Нельзя переиспользовать картинку только потому, что русские названия совпали.
