import type { AwardDefinition, AwardImage } from "../types.ts";

type AwardVisualOverride = {
  image?: AwardImage;
  degreeImages?: Record<string, AwardImage>;
};

const localImage = (
  src: string,
  sourcePage: string,
  license: string,
  author?: string,
): AwardImage => ({ src, sourcePage, license, author });

/**
 * Runtime visuals are local transparent assets. Paths are intentionally scoped
 * by award system/country: identical award names in different countries must
 * never share an image merely because their Russian display names match.
 */
const AWARD_VISUAL_OVERRIDES: Record<string, AwardVisualOverride> = {
  "ussr-medal-for-courage": {
    image: localImage(
      "/awards/ussr/medal-for-courage.svg",
      "https://commons.wikimedia.org/wiki/File:Medal_of_Valour,_Soviet_Union.png",
      "PD-RU-exempt",
      "Локальная SVG-реконструкция Drevo по официальному дизайну награды СССР",
    ),
  },
  "ussr-order-glory": {
    degreeImages: {
      "3": localImage(
        "/awards/ussr/order-glory-3.svg",
        "https://commons.wikimedia.org/wiki/File:Order_of_Glory_3rd_class.jpg",
        "CC BY-SA 3.0 / дизайн государственной награды СССР",
        "Локальная SVG-реконструкция Drevo",
      ),
    },
  },
  "ussr-medal-victory-germany": {
    image: localImage(
      "/awards/ussr/medal-victory-germany.svg",
      "https://commons.wikimedia.org/wiki/File:WW2_Victory.png",
      "CC BY-SA 3.0 / дизайн государственной награды СССР",
      "Локальная SVG-реконструкция Drevo",
    ),
  },
  "ussr-medal-capture-konigsberg": {
    image: localImage(
      "/awards/ussr/medal-capture-konigsberg.svg",
      "https://commons.wikimedia.org/wiki/File:Capture_of_Koenigsberg_OBVERSE.jpg",
      "CC BY-SA 3.0 / дизайн государственной награды СССР",
      "Локальная SVG-реконструкция Drevo",
    ),
  },
  "ussr-medal-capture-berlin": {
    image: localImage(
      "/awards/ussr/medal-capture-berlin.svg",
      "https://commons.wikimedia.org/wiki/File:Medal_For_the_Capture_of_Berlin.jpg",
      "PD-RU-exempt",
      "Локальная SVG-реконструкция Drevo",
    ),
  },
  "ussr-medal-veteran-labour": {
    image: localImage(
      "/awards/ussr/medal-veteran-labour.svg",
      "https://commons.wikimedia.org/wiki/File:VeteranOfLabourMedal3.jpg",
      "Дизайн государственной награды СССР; фото-источник CC BY-SA 3.0",
      "Локальная SVG-реконструкция Drevo",
    ),
  },
  "ru-rosatom-veteran-nuclear-energy-industry": {
    image: localImage(
      "/awards/ru/rosatom/veteran-nuclear-energy-industry.svg",
      "https://base.garant.ru/70183948/10ed0f917186039eb157d3ba4f962ee5/",
      "Официальный рисунок ведомственного знака; локальная SVG-реконструкция",
      "Drevo",
    ),
  },
  "mn-jubilee-30-khalkhin-gol-victory": {
    image: localImage(
      "/awards/mn/medal-30-khalkhin-gol-victory.svg",
      "https://commons.wikimedia.org/wiki/File:%D0%9C%D0%B5%D0%B4%D0%B0%D0%BB%D1%8C_%C2%AB30_%D0%BB%D0%B5%D1%82_%D0%A5%D0%B0%D0%BB%D1%85%D0%B8%D0%BD-%D0%93%D0%BE%D0%BB%D1%8C%D1%81%D0%BA%D0%BE%D0%B9_%D0%9F%D0%BE%D0%B1%D0%B5%D0%B4%D1%8B%C2%BB.jpg",
      "PD-Mongolia-exempt",
      "Локальная SVG-реконструкция Drevo",
    ),
  },
};

export function withAwardVisual(definition: AwardDefinition): AwardDefinition {
  const override = AWARD_VISUAL_OVERRIDES[definition.id];
  if (!override) return definition;

  const degrees = definition.degrees?.map((degree) => {
    const image = override.degreeImages?.[degree.id];
    return image ? { ...degree, image } : degree;
  });

  return {
    ...definition,
    image: override.image ?? definition.image,
    degrees,
    imageStatus: "verified",
  };
}
