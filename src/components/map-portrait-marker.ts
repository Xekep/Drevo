import { fullName, safeUrl, type Person } from "../domain";

/** Один человек может иметь несколько событий и исторических названий в одной точке. */
export function markerPeople(people: Person[]) {
  return [...new Map(people.map((p) => [p.id, p])).values()].sort(
    (a, b) =>
      Number(!!safeUrl(b.photo)) - Number(!!safeUrl(a.photo)) ||
      fullName(a).localeCompare(fullName(b), "ru") ||
      a.id.localeCompare(b.id),
  );
}

export function portraitMarker(people: Person[]) {
  const members = markerPeople(people);
  const content = document.createElement("div");
  content.className = "map-portrait-stack";
  for (const [i, person] of members.slice(0, 3).entries()) {
    const portrait = document.createElement("span");
    portrait.className = "map-portrait";
    portrait.style.left = `${i * 16}px`;
    portrait.style.zIndex = String(3 - i);
    portrait.title = fullName(person);
    const silhouette = document.createElement("span");
    silhouette.className = "map-portrait-silhouette";
    silhouette.setAttribute("aria-hidden", "true");
    portrait.append(silhouette);
    const src = safeUrl(person.photo);
    if (src) {
      const image = document.createElement("img");
      image.src = src;
      image.alt = "";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      portrait.append(image);
    }
    content.append(portrait);
  }
  if (members.length > 1) {
    const count = document.createElement("span");
    count.className = "map-portrait-count";
    count.textContent = String(members.length);
    content.append(count);
  }
  return {
    content,
    width: 48 + Math.max(0, Math.min(3, members.length) - 1) * 16,
  };
}
