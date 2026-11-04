// Shared geometry for the DOM SVG and the canvas/GPU previews (80 × 80).
export const cameoBody = "M18 69c1-14 9-22 22-22s21 8 22 22";
export const cameoOrnament = "M10 48c0 10 5 19 13 23M70 48c0 10-5 19-13 23M13 55l-5-4m8 12-7-2m58-6 5-4m-8 12 7-2";

export function drawPortraitCameo(context: CanvasRenderingContext2D, sex: "f" | "m" | "u", compact = false) {
  const colors = sex === "f" ? ["#fff9ee", "#ede4d7", "#a58c78"]
    : ["#fafbf3", "#e4ead9", sex === "m" ? "#71856b" : "#8a927f"];
  context.save();
  // CSS radial-gradient(circle at 40% 25%): farthest corner, as in directory.css.
  const background = context.createRadialGradient(32, 20, 0, 32, 20, Math.hypot(48, 60));
  background.addColorStop(0, colors[0]);
  background.addColorStop(1, colors[1]);
  context.fillStyle = background;
  context.fillRect(0, 0, 80, 80);
  context.fillStyle = context.strokeStyle = colors[2];
  if (!compact) {
    context.globalAlpha = 0.3;
    context.lineWidth = 0.6;
    context.beginPath();
    context.arc(40, 40, 34, 0, Math.PI * 2);
    context.stroke();
  }
  context.globalAlpha = 0.23;
  context.fill(new Path2D(cameoBody));
  context.globalAlpha = 0.35;
  context.beginPath();
  context.ellipse(40, 30, 12, 15, 0, 0, Math.PI * 2);
  context.fill();
  if (!compact) {
    context.globalAlpha = 0.45;
    context.lineWidth = 1.1;
    context.lineCap = "round";
    context.stroke(new Path2D(cameoOrnament));
  }
  context.restore();
}
