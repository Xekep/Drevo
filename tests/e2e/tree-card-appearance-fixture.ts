import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PortraitPlaceholder } from "../../src/components/portrait-placeholder";

export { createGpuScene } from "../../src/components/tree/gpu-scene";
export const placeholder = renderToStaticMarkup(createElement(PortraitPlaceholder));
