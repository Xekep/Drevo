declare module "page-flip" {
  export class PageFlip {
    constructor(
      element: HTMLElement,
      settings: {
        width: number;
        height: number;
        size?: "fixed" | "stretch";
        minWidth?: number;
        maxWidth?: number;
        minHeight?: number;
        maxHeight?: number;
        showCover?: boolean;
        usePortrait?: boolean;
        autoSize?: boolean;
        flippingTime?: number;
        maxShadowOpacity?: number;
        mobileScrollSupport?: boolean;
      },
    );
    loadFromHTML(elements: HTMLElement[]): void;
    on(event: "flip", handler: (event: { data: number }) => void): void;
    on(
      event: "changeOrientation",
      handler: (event: { data: "portrait" | "landscape" }) => void,
    ): void;
    on(
      event: "changeState",
      handler: (event: {
        data: "user_fold" | "fold_corner" | "flipping" | "read";
      }) => void,
    ): void;
    flipNext(): void;
    flipPrev(): void;
    turnToPage(index: number): void;
    getCurrentPageIndex(): number;
    getPage(index: number): {
      setDensity(density: "soft" | "hard"): void;
    };
    getFlipController(): {
      getCalculation(): { getDirection(): 0 | 1 } | null;
    };
    getOrientation(): "portrait" | "landscape";
    update(): void;
    getBoundsRect(): {
      pageWidth: number;
      height: number;
      width: number;
      left: number;
      top: number;
    };
    destroy(): void;
  }
}
