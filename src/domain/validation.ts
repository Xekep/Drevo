import { EXTRA_LINK_TYPES, type Family } from "./types.ts";
import { validDate, dateBound, safeUrl } from "./dates.ts";
export function validateFamily(value: unknown): Family {
  if (!value || typeof value !== "object")
    throw new Error("Некорректный формат архива");
  const data = value as Family;
  if (
    typeof data.title !== "string" ||
    typeof data.description !== "string" ||
    typeof data.demo !== "boolean" ||
    !Array.isArray(data.people) ||
    data.people.length > 10000
  )
    throw new Error("В архиве нет данных о людях");
  const ids = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);
  for (const p of data.people) {
    if (
      !p ||
      typeof p.id !== "string" ||
      !p.id ||
      ids.has(p.id) ||
      ![p.name, p.surname, p.patronymic, p.birthPlace].every(
        (s) => typeof s === "string",
      ) ||
      !["m", "f", "u"].includes(p.sex) ||
      (p.birth !== "" && !validDate(p.birth)) ||
      (p.death !== undefined &&
        (!validDate(p.death) ||
          (!!p.birth &&
            dateBound(p.death, true) < dateBound(p.birth, false)))) ||
      !Array.isArray(p.parents) ||
      !Array.isArray(p.spouses) ||
      ![...p.parents, ...p.spouses].every((id) => typeof id === "string") ||
      !Number.isInteger(p.generation) ||
      p.generation < 1 ||
      !Number.isFinite(p.column) ||
      p.column < 0 ||
      !Array.isArray(p.sources)
    )
      throw new Error("Некорректная карточка человека");
    for (const key of ["birthLocation", "deathLocation"] as const) {
      const location = p[key];
      if (
        location !== undefined &&
        (!location ||
          typeof location !== "object" ||
          typeof location.place !== "string" ||
          !location.place.trim() ||
          location.place.length > 1000 ||
          !Number.isFinite(location.lat) ||
          !Number.isFinite(location.lon) ||
          Math.abs(location.lat) > 90 ||
          Math.abs(location.lon) > 180 ||
          (location.label !== undefined &&
            (typeof location.label !== "string" ||
              location.label.length > 1000)))
      )
        throw new Error("Проверьте координаты места");
    }
    for (const key of [
      "deathPlace",
      "maidenName",
      "occupation",
      "biography",
      "photo",
    ] as const)
      if (p[key] !== undefined && typeof p[key] !== "string")
        throw new Error("Некорректные сведения о человеке");
    for (const s of p.sources)
      if (
        !s ||
        ![s.title, s.type, s.reference].every((v) => typeof v === "string") ||
        (s.url !== undefined && typeof s.url !== "string") ||
        (s.note !== undefined && typeof s.note !== "string")
      )
        throw new Error("Некорректный источник");
    if (p.awards !== undefined) {
      if (!Array.isArray(p.awards) || p.awards.length > 100)
        throw new Error("Допустимо не более 100 наград у человека");
      const awardIds = new Set<string>();
      for (const award of p.awards) {
        if (
          !award ||
          typeof award.id !== "string" ||
          !award.id ||
          award.id.length > 100 ||
          awardIds.has(award.id) ||
          typeof award.name !== "string" ||
          !award.name.trim() ||
          award.name.length > 300 ||
          (award.year !== undefined &&
            award.year !== "" &&
            (typeof award.year !== "string" ||
              !/^\d{4}$/.test(award.year) ||
              !validDate(award.year) ||
              award.year > today.slice(0, 4)))
        )
          throw new Error("Проверьте название и год награды");
        if (
          award.source !== undefined &&
          (!award.source ||
            typeof award.source !== "object" ||
            typeof award.source.title !== "string" ||
            award.source.title.length > 2000 ||
            (award.source.url !== undefined &&
              (typeof award.source.url !== "string" ||
                award.source.url.length > 2048 ||
                !/^https?:\/\/[^\s]+$/i.test(award.source.url) ||
                !safeUrl(award.source.url))))
        )
          throw new Error("Проверьте источник награды и ссылку HTTP/HTTPS");
        awardIds.add(award.id);
      }
    }
    ids.add(p.id);
    if (
      p.parentageComplete !== undefined &&
      typeof p.parentageComplete !== "boolean"
    )
      throw new Error("Некорректный признак полноты родительских сведений");
    if (
      !p.name.trim() ||
      !p.surname.trim() ||
      p.birth > today ||
      (p.death && p.death > today)
    )
      throw new Error("Проверьте имя и даты человека");
    if (
      new Set(p.parents).size !== p.parents.length ||
      new Set(p.spouses).size !== p.spouses.length
    )
      throw new Error("Семейная связь указана несколько раз");
  }
  const map = new Map(data.people.map((p) => [p.id, p]));
  for (const p of data.people) {
    if ([...p.parents, ...p.spouses].some((id) => !ids.has(id) || id === p.id))
      throw new Error("Обнаружена неизвестная семейная связь");
    if (
      p.birth &&
      p.parents.some(
        (id) =>
          map.get(id)!.birth &&
          dateBound(map.get(id)!.birth, false) >= dateBound(p.birth, true),
      )
    )
      throw new Error("Родитель должен родиться раньше ребёнка");
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) throw new Error("В родительских связях найден цикл");
    if (visited.has(id)) return;
    active.add(id);
    map.get(id)!.parents.forEach(visit);
    active.delete(id);
    visited.add(id);
  }
  data.people.forEach((p) => visit(p.id));
  if (data.links !== undefined && !Array.isArray(data.links))
    throw new Error("Некорректный список дополнительных связей");
  const linkIds = new Set<string>(),
    pairs = new Set<string>();
  for (const link of data.links || []) {
    if (
      !link ||
      typeof link.id !== "string" ||
      !link.id ||
      linkIds.has(link.id) ||
      !ids.has(link.from) ||
      !ids.has(link.to) ||
      link.from === link.to ||
      !EXTRA_LINK_TYPES.includes(link.type) ||
      (link.note !== undefined && typeof link.note !== "string")
    )
      throw new Error("Некорректная дополнительная связь");
    const pair =
      link.type === "sworn_sibling"
        ? [link.from, link.to].sort().join(":")
        : `${link.from}:${link.to}`;
    const key = `${link.type}:${pair}`;
    if (pairs.has(key)) throw new Error("Такая связь уже существует");
    if (
      ["adoptive_parent", "nurse"].includes(link.type) &&
      map.get(link.from)!.birth &&
      map.get(link.to)!.birth &&
      dateBound(map.get(link.from)!.birth, false) >=
        dateBound(map.get(link.to)!.birth, true)
    )
      throw new Error("Родитель или кормилица должны родиться раньше ребёнка");
    linkIds.add(link.id);
    pairs.add(key);
  }
  // Adoption must not introduce a cycle into the combined parent graph.
  const parentGraph = new Map(data.people.map((p) => [p.id, [...p.parents]]));
  for (const link of data.links || [])
    if (link.type === "adoptive_parent")
      parentGraph.get(link.to)!.push(link.from);
  visited.clear();
  active.clear();
  function visitParent(id: string) {
    if (active.has(id))
      throw new Error("Усыновление создаёт цикл в родительских связях");
    if (visited.has(id)) return;
    active.add(id);
    parentGraph.get(id)!.forEach(visitParent);
    active.delete(id);
    visited.add(id);
  }
  data.people.forEach((p) => visitParent(p.id));
  if (data.photos !== undefined && !Array.isArray(data.photos))
    throw new Error("Некорректная галерея");
  const photoIds = new Set<string>();
  for (const photo of data.photos || []) {
    if (
      !photo ||
      typeof photo.id !== "string" ||
      !photo.id ||
      photoIds.has(photo.id) ||
      typeof photo.title !== "string" ||
      typeof photo.url !== "string" ||
      !/^\/media\/[a-zA-Z0-9-]+\.(jpg|png|webp|gif)$/.test(photo.url) ||
      !Array.isArray(photo.tags) ||
      (photo.createdAt !== undefined &&
        (typeof photo.createdAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
            photo.createdAt,
          ) ||
          !Number.isFinite(Date.parse(photo.createdAt)))) ||
      (photo.takenAt !== undefined && typeof photo.takenAt !== "string") ||
      (photo.place !== undefined && typeof photo.place !== "string") ||
      (photo.event !== undefined && typeof photo.event !== "string") ||
      (photo.year !== undefined &&
        (typeof photo.year !== "string" ||
          (photo.year !== "" && !/^\d{4}$/.test(photo.year)))) ||
      (photo.description !== undefined && typeof photo.description !== "string")
    )
      throw new Error("Некорректная фотография");
    photoIds.add(photo.id);
    const tags = new Set<string>();
    for (const tag of photo.tags) {
      if (
        !tag ||
        typeof tag.id !== "string" ||
        !tag.id ||
        tags.has(tag.id) ||
        !ids.has(tag.personId) ||
        ![tag.x, tag.y, tag.width, tag.height].every(Number.isFinite) ||
        tag.x < 0 ||
        tag.y < 0 ||
        tag.width <= 0 ||
        tag.height <= 0 ||
        tag.x + tag.width > 1.00001 ||
        tag.y + tag.height > 1.00001
      )
        throw new Error("Некорректная отметка человека на фото");
      tags.add(tag.id);
    }
  }
  return data;
}
