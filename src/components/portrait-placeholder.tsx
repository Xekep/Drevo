/** Нейтральная камея: декоративный силуэт, не предположение о внешности человека. */
export function PortraitPlaceholder() {
  return (
    <svg
      className="portrait-placeholder"
      viewBox="0 0 80 80"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="40"
        cy="40"
        r="34"
        fill="none"
        stroke="currentColor"
        strokeWidth=".6"
        opacity=".3"
      />
      <path
        d="M18 69c1-14 9-22 22-22s21 8 22 22"
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
      <path
        d="M10 48c0 10 5 19 13 23M70 48c0 10-5 19-13 23M13 55l-5-4m8 12-7-2m58-6 5-4m-8 12 7-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity=".45"
      />
    </svg>
  );
}
