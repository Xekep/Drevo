import { cameoBody, cameoOrnament } from "./portrait-cameo";

/** Нейтральная камея: декоративный силуэт, не предположение о внешности человека. */
export function PortraitPlaceholder({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className="portrait-placeholder"
      viewBox="0 0 80 80"
      aria-hidden="true"
      focusable="false"
    >
      {!compact && <circle
        cx="40"
        cy="40"
        r="34"
        fill="none"
        stroke="currentColor"
        strokeWidth=".6"
        opacity=".3"
      />}
      <path
        d={cameoBody}
        fill="currentColor"
        opacity=".23"
      />
      <ellipse
        cx="40"
        cy="30"
        rx="12"
        ry="15"
        fill="currentColor"
        opacity=".35"
      />
      {!compact && <path
        d={cameoOrnament}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity=".45"
      />}
    </svg>
  );
}
