# Источники изображений наград

В профиле человека используются локальные прозрачные PNG из `public/awards/`. Внешние страницы нужны только как источник происхождения и лицензии: интерфейс не должен зависеть от Wikimedia Commons и не должен показывать исходные фотографии с белой подложкой.

Каталоги разделены по системе наград, а не по русскому названию. СССР хранится в `public/awards/ussr/`, современная Россия — в `public/awards/ru/`, Монголия/МНР — в `public/awards/mn/`. Одинаково называющиеся награды разных государств обязаны иметь разные `awardDefinitionId` и разные файлы.

| Награда | Локальный PNG | Основа / источник | Лицензия источника |
| --- | --- | --- | --- |
| Медаль «За отвагу» (СССР) | `/awards/ussr/medal-for-courage.png` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Medal_of_Valour,_Soviet_Union.png) | PD-RU-exempt |
| Орден Славы III степени (СССР) | `/awards/ussr/order-glory-3.png` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Order_of_Glory_3rd_class.jpg) | CC BY-SA 3.0 |
| Медаль «За победу над Германией…» (СССР) | `/awards/ussr/medal-victory-germany.png` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:WW2_Victory.png) | CC BY-SA 3.0 |
| Медаль «За взятие Кёнигсберга» (СССР) | `/awards/ussr/medal-capture-konigsberg.png` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Capture_of_Koenigsberg_OBVERSE.jpg) | CC BY-SA 3.0 |
| Медаль «За взятие Берлина» (СССР) | `/awards/ussr/medal-capture-berlin.png` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Medal_For_the_Capture_of_Berlin.jpg) | PD-RU-exempt |
| Медаль «Ветеран труда» (СССР) | `/awards/ussr/medal-veteran-labour.png` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:VeteranOfLabourMedal3.jpg) | Public domain |
| Знак «Ветеран атомной энергетики и промышленности» (Россия, Росатом) | `/awards/ru/rosatom/veteran-nuclear-energy-industry.png` | [Галерея «БОСПОР»](https://bosporshop.ru/catalog/faleristika/znaki_znachki/energetika/znak_rosatom_veteran_atomnoy_energetiki_i_promyshlennosti_s_frachnym_znakom_2010_2020_gg_v_korobke) | права на фотографию у правообладателя; требуется проверка условий повторного использования |
| «30 лет Халхин-Гольской Победы» (МНР) | `/awards/mn/medal-30-khalkhin-gol-victory.png` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Медаль_«30_лет_Халхин-Гольской_Победы».jpg) | PD-Mongolia-exempt |

Для современного знака Росатома используется реальная фотография экземпляра с красной колодкой, совпадающей с официальным описанием ведомственного знака 2012/2014 годов. В каталоге она помечена `pending-license-review`, потому что права на саму фотографию отдельно не подтверждены свободной лицензией.

PNG создаются скриптом `ops/fetch-award-images.sh`: из исходной фотографии/скана удаляется только связанный с краями фон, затем изображение сохраняется как PNG32. Для JPEG с неоднородным фоном очистка выполняется со всех четырёх углов. Геометрия, надписи и детали самой награды не перерисовываются.

Перед добавлением нового визуала нужно проверить конкретную систему наград, страну, степень/класс и источник. Нельзя переиспользовать картинку только потому, что русские названия совпали.
