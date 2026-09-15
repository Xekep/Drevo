import type { AwardDefinition, AwardImage } from "../types.ts";

type AwardVisualOverride = {
  image?: AwardImage;
  degreeImages?: Record<string, AwardImage>;
};

const commonsImage = (
  src: string,
  sourcePage: string,
  license: string,
  author?: string,
): AwardImage => ({ src, sourcePage, license, author });

/**
 * Verified images are kept separately from award metadata so visual coverage can
 * grow without making the historical catalogue harder to review. The image URL
 * points directly at upload.wikimedia.org to avoid an extra Commons redirect in
 * person cards.
 */
const AWARD_VISUAL_OVERRIDES: Record<string, AwardVisualOverride> = {
  "ussr-medal-for-courage": {
    image: commonsImage(
      "https://upload.wikimedia.org/wikipedia/commons/b/b9/Medal_of_Valour%2C_Soviet_Union.png",
      "https://commons.wikimedia.org/wiki/File:Medal_of_Valour,_Soviet_Union.png",
      "PD-RU-exempt",
      "Ahnode (retouch; original author unknown)",
    ),
  },
  "ussr-order-glory": {
    degreeImages: {
      "3": commonsImage(
        "https://upload.wikimedia.org/wikipedia/commons/3/3c/Order_of_Glory_3rd_class.jpg",
        "https://commons.wikimedia.org/wiki/File:Order_of_Glory_3rd_class.jpg",
        "CC BY-SA 3.0",
        "Fdutil",
      ),
    },
  },
  "ussr-medal-victory-germany": {
    image: commonsImage(
      "https://upload.wikimedia.org/wikipedia/commons/a/aa/%D0%97%D0%B0_%D0%BF%D0%BE%D0%B1%D0%B5%D0%B4%D1%83_%D0%BD%D0%B0%D0%B4_%D0%93%D0%B5%D1%80%D0%BC%D0%B0%D0%BD%D0%B8%D0%B5%D0%B9_%D0%B2_%D0%92%D0%B5%D0%BB%D0%B8%D0%BA%D0%BE%D0%B9_%D0%9E%D1%82%D0%B5%D1%87%D0%B5%D1%81%D1%82%D0%B2%D0%B5%D0%BD%D0%BD%D0%BE%D0%B9_%D0%B2%D0%BE%D0%B9%D0%BD%D0%B5_1941%E2%80%941945_%D0%B3%D0%B3.jpg",
      "https://commons.wikimedia.org/wiki/File:%D0%97%D0%B0_%D0%BF%D0%BE%D0%B1%D0%B5%D0%B4%D1%83_%D0%BD%D0%B0%D0%B4_%D0%93%D0%B5%D1%80%D0%BC%D0%B0%D0%BD%D0%B8%D0%B5%D0%B9_%D0%B2_%D0%92%D0%B5%D0%BB%D0%B8%D0%BA%D0%BE%D0%B9_%D0%9E%D1%82%D0%B5%D1%87%D0%B5%D1%81%D1%82%D0%B2%D0%B5%D0%BD%D0%BD%D0%BE%D0%B9_%D0%B2%D0%BE%D0%B9%D0%BD%D0%B5_1941%E2%80%941945_%D0%B3%D0%B3.jpg",
      "CC BY-SA 1.0",
      "George Shuklin",
    ),
  },
  "ussr-medal-capture-konigsberg": {
    image: commonsImage(
      "https://upload.wikimedia.org/wikipedia/commons/2/21/Capture_of_Koenigsberg_OBVERSE.jpg",
      "https://commons.wikimedia.org/wiki/File:Capture_of_Koenigsberg_OBVERSE.jpg",
      "CC BY-SA 3.0",
      "Fdutil",
    ),
  },
  "ussr-medal-capture-berlin": {
    image: commonsImage(
      "https://upload.wikimedia.org/wikipedia/commons/4/4e/Medal_For_the_Capture_of_Berlin.jpg",
      "https://commons.wikimedia.org/wiki/File:Medal_For_the_Capture_of_Berlin.jpg",
      "PD-RU-exempt",
      "Winterheart",
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
