/** Liquid Morphology configuration and presets, filipz (MIT). See public/licenses/liquid-morphology-MIT.txt. */
export const chronicleEffects = {
  glass: "Стекло",
  frost: "Иней",
  ripple: "Рябь",
  plasma: "Плазма",
  timeshift: "Сдвиг времени",
} as const;
export type ChronicleEffect = keyof typeof chronicleEffects;
export const chronicleFields = {
  transitionDuration: {
    label: "Длительность перехода, с",
    default: 2.5,
    min: 0.5,
    max: 5,
    step: 0.1,
  },
  autoSlideSpeed: {
    label: "Время показа, мс",
    default: 5000,
    min: 2000,
    max: 10000,
    step: 500,
  },
  globalIntensity: {
    label: "Общая интенсивность",
    default: 1,
    min: 0.1,
    max: 2,
    step: 0.1,
  },
  speedMultiplier: {
    label: "Скорость движения",
    default: 1,
    min: 0.1,
    max: 3,
    step: 0.1,
  },
  distortionStrength: {
    label: "Сила искажения",
    default: 1,
    min: 0.1,
    max: 3,
    step: 0.1,
  },
  colorEnhancement: {
    label: "Усиление цвета",
    default: 1,
    min: 0.5,
    max: 2,
    step: 0.1,
  },
  glassRefractionStrength: {
    label: "Преломление",
    default: 1,
    min: 0.1,
    max: 3,
    step: 0.1,
  },
  glassChromaticAberration: {
    label: "Хроматическая аберрация",
    default: 1,
    min: 0.1,
    max: 3,
    step: 0.1,
  },
  glassBubbleClarity: {
    label: "Прозрачность пузыря",
    default: 1,
    min: 0.1,
    max: 2,
    step: 0.1,
  },
  glassEdgeGlow: {
    label: "Свечение кромки",
    default: 1,
    min: 0,
    max: 2,
    step: 0.1,
  },
  glassLiquidFlow: {
    label: "Течение",
    default: 1,
    min: 0.1,
    max: 3,
    step: 0.1,
  },
  frostIntensity: {
    label: "Интенсивность инея",
    default: 1.5,
    min: 0.5,
    max: 3,
    step: 0.1,
  },
  frostCrystalSize: {
    label: "Размер кристаллов",
    default: 1,
    min: 0.3,
    max: 2,
    step: 0.1,
  },
  frostIceCoverage: {
    label: "Покрытие льдом",
    default: 1,
    min: 0.1,
    max: 2,
    step: 0.1,
  },
  frostTemperature: {
    label: "Температура",
    default: 1,
    min: 0.1,
    max: 3,
    step: 0.1,
  },
  frostTexture: {
    label: "Детализация текстуры",
    default: 1,
    min: 0.3,
    max: 2,
    step: 0.1,
  },
  rippleFrequency: {
    label: "Частота волн",
    default: 25,
    min: 10,
    max: 50,
    step: 1,
  },
  rippleAmplitude: {
    label: "Амплитуда волн",
    default: 0.08,
    min: 0.02,
    max: 0.2,
    step: 0.01,
  },
  rippleWaveSpeed: {
    label: "Скорость волн",
    default: 1,
    min: 0.2,
    max: 3,
    step: 0.1,
  },
  rippleRippleCount: {
    label: "Количество волн",
    default: 1,
    min: 0.1,
    max: 2,
    step: 0.1,
  },
  rippleDecay: {
    label: "Затухание",
    default: 1,
    min: 0.2,
    max: 2,
    step: 0.1,
  },
  plasmaIntensity: {
    label: "Интенсивность плазмы",
    default: 1.2,
    min: 0.5,
    max: 3,
    step: 0.1,
  },
  plasmaSpeed: {
    label: "Скорость плазмы",
    default: 0.8,
    min: 0.2,
    max: 2,
    step: 0.1,
  },
  plasmaEnergyIntensity: {
    label: "Энергия свечения",
    default: 0.4,
    min: 0,
    max: 1,
    step: 0.05,
  },
  plasmaContrastBoost: {
    label: "Усиление контраста",
    default: 0.3,
    min: 0,
    max: 1,
    step: 0.05,
  },
  plasmaTurbulence: {
    label: "Турбулентность плазмы",
    default: 1,
    min: 0.1,
    max: 3,
    step: 0.1,
  },
  timeshiftDistortion: {
    label: "Искажение времени",
    default: 1.6,
    min: 0.3,
    max: 3,
    step: 0.1,
  },
  timeshiftBlur: {
    label: "Размытие границы",
    default: 1.5,
    min: 0.3,
    max: 3,
    step: 0.1,
  },
  timeshiftFlow: {
    label: "Скорость потока",
    default: 1.4,
    min: 0.3,
    max: 3,
    step: 0.1,
  },
  timeshiftChromatic: {
    label: "Хроматический сдвиг",
    default: 1.5,
    min: 0,
    max: 3,
    step: 0.1,
  },
  timeshiftTurbulence: {
    label: "Турбулентность потока",
    default: 1.4,
    min: 0.3,
    max: 3,
    step: 0.1,
  },
} as const;
export type ChronicleNumericKey = keyof typeof chronicleFields;
export type ChronicleSettings = Record<ChronicleNumericKey, number> & {
  currentEffect: ChronicleEffect;
  currentEffectPreset: string;
};
export const chroniclePresets: Record<
  ChronicleEffect,
  Record<string, Partial<Record<ChronicleNumericKey, number>>>
> = {
  glass: {
    Subtle: {
      glassRefractionStrength: 0.6,
      glassChromaticAberration: 0.5,
      glassBubbleClarity: 1.3,
      glassEdgeGlow: 0.7,
      glassLiquidFlow: 0.8,
    },
    Default: {
      glassRefractionStrength: 1,
      glassChromaticAberration: 1,
      glassBubbleClarity: 1,
      glassEdgeGlow: 1,
      glassLiquidFlow: 1,
    },
    Crystal: {
      glassRefractionStrength: 1.5,
      glassChromaticAberration: 1.8,
      glassBubbleClarity: 0.7,
      glassEdgeGlow: 1.4,
      glassLiquidFlow: 0.5,
    },
    Liquid: {
      glassRefractionStrength: 0.8,
      glassChromaticAberration: 0.4,
      glassBubbleClarity: 1.2,
      glassEdgeGlow: 0.8,
      glassLiquidFlow: 1.8,
    },
  },
  frost: {
    Light: {
      frostIntensity: 0.8,
      frostCrystalSize: 1.3,
      frostIceCoverage: 0.6,
      frostTemperature: 0.7,
      frostTexture: 0.8,
    },
    Default: {
      frostIntensity: 1.5,
      frostCrystalSize: 1,
      frostIceCoverage: 1,
      frostTemperature: 1,
      frostTexture: 1,
    },
    Heavy: {
      frostIntensity: 2.2,
      frostCrystalSize: 0.7,
      frostIceCoverage: 1.4,
      frostTemperature: 1.5,
      frostTexture: 1.3,
    },
    Arctic: {
      frostIntensity: 2.8,
      frostCrystalSize: 0.5,
      frostIceCoverage: 1.8,
      frostTemperature: 2,
      frostTexture: 1.6,
    },
  },
  ripple: {
    Gentle: {
      rippleFrequency: 15,
      rippleAmplitude: 0.05,
      rippleWaveSpeed: 0.7,
      rippleRippleCount: 0.8,
      rippleDecay: 1.2,
    },
    Default: {
      rippleFrequency: 25,
      rippleAmplitude: 0.08,
      rippleWaveSpeed: 1,
      rippleRippleCount: 1,
      rippleDecay: 1,
    },
    Strong: {
      rippleFrequency: 35,
      rippleAmplitude: 0.12,
      rippleWaveSpeed: 1.4,
      rippleRippleCount: 1.3,
      rippleDecay: 0.8,
    },
    Tsunami: {
      rippleFrequency: 45,
      rippleAmplitude: 0.18,
      rippleWaveSpeed: 1.8,
      rippleRippleCount: 1.6,
      rippleDecay: 0.6,
    },
  },
  plasma: {
    Calm: {
      plasmaIntensity: 0.8,
      plasmaSpeed: 0.5,
      plasmaEnergyIntensity: 0.2,
      plasmaContrastBoost: 0.1,
      plasmaTurbulence: 0.6,
    },
    Default: {
      plasmaIntensity: 1.2,
      plasmaSpeed: 0.8,
      plasmaEnergyIntensity: 0.4,
      plasmaContrastBoost: 0.3,
      plasmaTurbulence: 1,
    },
    Storm: {
      plasmaIntensity: 1.8,
      plasmaSpeed: 1.3,
      plasmaEnergyIntensity: 0.7,
      plasmaContrastBoost: 0.5,
      plasmaTurbulence: 1.5,
    },
    Nuclear: {
      plasmaIntensity: 2.5,
      plasmaSpeed: 1.8,
      plasmaEnergyIntensity: 1,
      plasmaContrastBoost: 0.8,
      plasmaTurbulence: 2,
    },
  },
  timeshift: {
    Subtle: {
      timeshiftDistortion: 0.5,
      timeshiftBlur: 0.6,
      timeshiftFlow: 0.5,
      timeshiftChromatic: 0.4,
      timeshiftTurbulence: 0.6,
    },
    Default: {
      timeshiftDistortion: 1.6,
      timeshiftBlur: 1.5,
      timeshiftFlow: 1.4,
      timeshiftChromatic: 1.5,
      timeshiftTurbulence: 1.4,
    },
    Intense: {
      timeshiftDistortion: 2.2,
      timeshiftBlur: 2,
      timeshiftFlow: 2,
      timeshiftChromatic: 2.2,
      timeshiftTurbulence: 2,
    },
    Dreamlike: {
      timeshiftDistortion: 2.8,
      timeshiftBlur: 2.5,
      timeshiftFlow: 2.5,
      timeshiftChromatic: 2.6,
      timeshiftTurbulence: 2.5,
    },
  },
};
export const defaultChronicleSettings: Readonly<ChronicleSettings> =
  Object.freeze({
    transitionDuration: 2.5,
    autoSlideSpeed: 5000,
    currentEffect: "glass",
    currentEffectPreset: "Default",
    globalIntensity: 1,
    speedMultiplier: 1,
    distortionStrength: 1,
    colorEnhancement: 1,
    glassRefractionStrength: 1,
    glassChromaticAberration: 1,
    glassBubbleClarity: 1,
    glassEdgeGlow: 1,
    glassLiquidFlow: 1,
    frostIntensity: 1.5,
    frostCrystalSize: 1,
    frostIceCoverage: 1,
    frostTemperature: 1,
    frostTexture: 1,
    rippleFrequency: 25,
    rippleAmplitude: 0.08,
    rippleWaveSpeed: 1,
    rippleRippleCount: 1,
    rippleDecay: 1,
    plasmaIntensity: 1.2,
    plasmaSpeed: 0.8,
    plasmaEnergyIntensity: 0.4,
    plasmaContrastBoost: 0.3,
    plasmaTurbulence: 1,
    timeshiftDistortion: 1.6,
    timeshiftBlur: 1.5,
    timeshiftFlow: 1.4,
    timeshiftChromatic: 1.5,
    timeshiftTurbulence: 1.4,
  });
export type ChronicleConfiguration = {
  version: number;
  settings: ChronicleSettings;
  canConfigure: boolean;
};
export function validateChronicleSettings(value: unknown): ChronicleSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RangeError("Некорректные настройки хроники");
  const input = value as Record<string, unknown>;
  const keys = [
    "currentEffect",
    "currentEffectPreset",
    ...Object.keys(chronicleFields),
  ];
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw new RangeError("Некорректные поля настроек хроники");
  if (
    typeof input.currentEffect !== "string" ||
    !Object.hasOwn(chronicleEffects, input.currentEffect)
  )
    throw new RangeError("Неизвестный переход");
  const effect = input.currentEffect as ChronicleEffect;
  if (
    typeof input.currentEffectPreset !== "string" ||
    (input.currentEffectPreset !== "Custom" &&
      !Object.hasOwn(chroniclePresets[effect], input.currentEffectPreset))
  )
    throw new RangeError("Неизвестный пресет");
  for (const [key, field] of Object.entries(chronicleFields)) {
    const number = input[key];
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      number < field.min ||
      number > field.max
    )
      throw new RangeError(
        field.label + ": значение вне допустимого диапазона",
      );
  }
  return Object.fromEntries(
    keys.map((key) => [key, input[key]]),
  ) as ChronicleSettings;
}
