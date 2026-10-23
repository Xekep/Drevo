import { expect, test } from "@playwright/test";
import { aiChatDetailRoute, aiChatFixture } from "./ai-chat-fixture.ts";

test("saved formula fences have readable contrast and preserve code, inline text and math", async ({ page }, info) => {
  const content = [
    "Формула из прежнего ответа:",
    "```ini\nH = -Σ(pᵢ × log₂(pᵢ))\n```",
    "Обычный код:",
    "```\nH = -Σ(pᵢ × log₂(pᵢ))\n```",
    "Параметр `compact_threshold` сохраняется.",
    "$$\nH = -\\sum_i p_i \\log_2 p_i\n$$",
    "```ini\n[archive]\nenabled=true\n```",
  ].join("\n\n");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/ai/status", route => route.fulfill({ json: { enabled: true, streaming: true } }));
  await page.route("**/api/ai/chats", route => route.fulfill({ json: { chats: [{ id: "formulas", title: "Формулы", updatedAt: "2026-10-23" }] } }));
  await page.route(aiChatDetailRoute("formulas"), route => route.fulfill({ json: aiChatFixture(route.request().url(), "formulas", [{ role: "assistant", content }]) }));
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const fences = panel.locator("pre > code");
  await expect(fences).toHaveCount(3);
  await expect(fences.nth(0)).toHaveText("H = -Σ(pᵢ × log₂(pᵢ))");
  await expect(fences.nth(2)).toHaveText("[archive]\nenabled=true");
  const contrast = await fences.evaluateAll(elements => elements.map(element => {
    const foreground = getComputedStyle(element).color;
    const background = getComputedStyle(element.parentElement!).backgroundColor;
    const luminance = (color: string) => {
      const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      });
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const a = luminance(foreground), b = luminance(background);
    return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), codeBackground: getComputedStyle(element).backgroundColor };
  }));
  for (const item of contrast) {
    expect(item.ratio).toBeGreaterThanOrEqual(4.5);
    expect(item.codeBackground).toBe("rgba(0, 0, 0, 0)");
  }
  await expect(panel.locator("p > code")).toHaveText("compact_threshold");
  await expect(panel.locator(".katex-display")).toHaveCount(1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("formulas.png") });
});
