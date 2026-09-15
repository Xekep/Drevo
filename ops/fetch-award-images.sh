#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/awards"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT/ussr" "$OUT/mn"

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
  local fuzz="${3:-12%}"
  local bg
  bg="$(convert "$src" -format '%[pixel:p{0,0}]' info:)"

  # Удаляем только связанный с краем фон фотографии. Геометрия и рисунок награды
  # не перерисовываются и не дорисовываются.
  convert "$src" \
    -alpha on \
    -bordercolor "$bg" -border 1 \
    -fuzz "$fuzz" -fill none -draw 'matte 0,0 floodfill' \
    -shave 1x1 \
    -trim +repage \
    -resize '512x512>' \
    PNG32:"$dst"
}

# СССР. Реальные фотографии/сканы Wikimedia Commons.
fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Medal_of_Valour,_Soviet_Union.png' "$TMP/courage.png"
make_png "$TMP/courage.png" "$OUT/ussr/medal-for-courage.png" 10%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Order_of_Glory_3rd_class.jpg' "$TMP/glory3.jpg"
make_png "$TMP/glory3.jpg" "$OUT/ussr/order-glory-3.png" 14%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/WW2_Victory.png' "$TMP/victory.png"
make_png "$TMP/victory.png" "$OUT/ussr/medal-victory-germany.png" 8%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Capture_of_Koenigsberg_OBVERSE.jpg' "$TMP/konigsberg.jpg"
make_png "$TMP/konigsberg.jpg" "$OUT/ussr/medal-capture-konigsberg.png" 14%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Medal_For_the_Capture_of_Berlin.jpg' "$TMP/berlin.jpg"
make_png "$TMP/berlin.jpg" "$OUT/ussr/medal-capture-berlin.png" 14%

fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/VeteranOfLabourMedal3.jpg' "$TMP/veteran-labour.jpg"
make_png "$TMP/veteran-labour.jpg" "$OUT/ussr/medal-veteran-labour.png" 14%

# МНР.
fetch 'https://commons.wikimedia.org/wiki/Special:Redirect/file/%D0%9C%D0%B5%D0%B4%D0%B0%D0%BB%D1%8C%20%C2%AB30%20%D0%BB%D0%B5%D1%82%20%D0%A5%D0%B0%D0%BB%D1%85%D0%B8%D0%BD-%D0%93%D0%BE%D0%BB%D1%8C%D1%81%D0%BA%D0%BE%D0%B9%20%D0%9F%D0%BE%D0%B1%D0%B5%D0%B4%D1%8B%C2%BB.jpg' "$TMP/khalkhin-gol.jpg"
make_png "$TMP/khalkhin-gol.jpg" "$OUT/mn/medal-30-khalkhin-gol-victory.png" 14%

printf 'Prepared real raster award assets in %s\n' "$OUT"
