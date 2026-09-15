#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/awards"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT/ussr" "$OUT/ru/rosatom" "$OUT/mn"

if ! command -v convert >/dev/null 2>&1; then
  echo "ImageMagick 'convert' is required" >&2
  exit 1
fi

fetch() {
  local url="$1"
  local dst="$2"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 120 \
    -A 'Drevo award asset fetcher/1.0' "$url" -o "$dst"
}

make_png() {
  local src="$1"
  local dst="$2"
  local fuzz="${3:-14%}"
  local crop="${4:-}"
  local prepared="$TMP/prepared-$(basename "$dst")"

  if [[ -n "$crop" ]]; then
    convert "$src" -gravity west -crop "$crop" +repage "$prepared"
  else
    convert "$src" "$prepared"
  fi

  local width height right bottom
  read -r width height < <(identify -format '%w %h' "$prepared")
  right=$((width - 1))
  bottom=$((height - 1))

  # Фон у музейных/аукционных фотографий часто не идеально однотонный.
  # Flood-fill из всех четырёх углов убирает только фон, связанный с краями,
  # и не пытается перерисовывать саму награду. Это заметно чище одного
  # top-left flood-fill на JPEG с тенями и градиентом.
  convert "$prepared" \
    -alpha on \
    -fuzz "$fuzz" -fill none \
    -draw 'matte 0,0 floodfill' \
    -draw "matte $right,0 floodfill" \
    -draw "matte 0,$bottom floodfill" \
    -draw "matte $right,$bottom floodfill" \
    -trim +repage \
    -resize '512x512>' \
    PNG32:"$dst"
}

# СССР. Реальные фотографии/сканы Wikimedia Commons.
fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Medal_of_Valour,_Soviet_Union.png' "$TMP/courage.png"
make_png "$TMP/courage.png" "$OUT/ussr/medal-for-courage.png" 11%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Order_of_Glory_3rd_class.jpg' "$TMP/glory3.jpg"
make_png "$TMP/glory3.jpg" "$OUT/ussr/order-glory-3.png" 18%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/WW2_Victory.png' "$TMP/victory.png"
make_png "$TMP/victory.png" "$OUT/ussr/medal-victory-germany.png" 10%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Capture_of_Koenigsberg_OBVERSE.jpg' "$TMP/konigsberg.jpg"
make_png "$TMP/konigsberg.jpg" "$OUT/ussr/medal-capture-konigsberg.png" 18%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Medal_For_the_Capture_of_Berlin.jpg' "$TMP/berlin.jpg"
make_png "$TMP/berlin.jpg" "$OUT/ussr/medal-capture-berlin.png" 18%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/VeteranOfLabourMedal3.jpg' "$TMP/veteran-labour.jpg"
make_png "$TMP/veteran-labour.jpg" "$OUT/ussr/medal-veteran-labour.png" 18%

# Россия / Росатом. Реальный знак с красной колодкой, соответствующей
# описанию ведомственного знака 2012/2014 гг. Справа на исходной фотографии
# лежит отдельный фрачный знак, поэтому до удаления фона отрезаем правую
# четверть кадра и оставляем только основную награду.
fetch 'https://bosporshop.ru/upload/iblock/22f/uz5xiqrc144vgc197p0lijgxmst790sa.jpg' "$TMP/rosatom-veteran.jpg"
make_png "$TMP/rosatom-veteran.jpg" "$OUT/ru/rosatom/veteran-nuclear-energy-industry.png" 16% '76%x100%+0+0'

# МНР.
fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/%D0%9C%D0%B5%D0%B4%D0%B0%D0%BB%D1%8C%20%C2%AB30%20%D0%BB%D0%B5%D1%82%20%D0%A5%D0%B0%D0%BB%D1%85%D0%B8%D0%BD-%D0%93%D0%BE%D0%BB%D1%8C%D1%81%D0%BA%D0%BE%D0%B9%20%D0%9F%D0%BE%D0%B1%D0%B5%D0%B4%D1%8B%C2%BB.jpg' "$TMP/khalkhin-gol.jpg"
make_png "$TMP/khalkhin-gol.jpg" "$OUT/mn/medal-30-khalkhin-gol-victory.png" 18%

printf 'Prepared real raster award assets in %s\n' "$OUT"
