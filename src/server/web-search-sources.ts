import type { ResearchSearchSettings } from "../shared/web-search.ts";

/** Only hostnames, never URLs, ports, credentials or wildcard expressions. */
export function searchDomain(value: string): string {
  if (!value || /[\s/@:#?%\\]/u.test(value))
    throw new RangeError("Некорректные настройки поиска");
  const hostname = new URL(`https://${value}`).hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !hostname
      .split(".")
      .every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)) ||
    /^[\d.]+$/.test(hostname)
  )
    throw new RangeError("Некорректные настройки поиска");
  return hostname;
}

export function domainMatches(host: string, allowed: string) {
  return host === allowed || host.endsWith(`.${allowed}`);
}

/** Adapter over the existing catalogue; no second list of websites. */
export function defaultSearchSettings(
  url: string,
  category: string,
  description = "",
): ResearchSearchSettings {
  const tags: Record<string, string[]> = {
    Архивы: ["archives", "genealogy"],
    Война: ["military"],
    Репрессии: ["repressions"],
    Захоронения: ["cemeteries", "memorials"],
    "Старые книги и газеты": [
      "books",
      "newspapers",
      "address_books",
      "directories",
    ],
    "Эмиграция и перемещённые лица": ["archives", "genealogy"],
    "Помощь с поиском": ["genealogy"],
  };
  let domain = "";
  try {
    domain = searchDomain(new URL(url).hostname);
  } catch {
    /* Non-indexable resource stays disabled. */
  }
  const categories = [...(tags[category] || ["general"])];
  if (category === "Война") {
    if (/1914|1918|Первая мировая/.test(description)) categories.push("ww1");
    else if (/ВОВ|пленные|Красная армия/.test(description))
      categories.push("ww2");
  }
  return { domain, enabledForAiSearch: !!domain, categories, priority: 0 };
}

export function validateSearchSettings(
  raw: Record<string, unknown>,
  defaults: ResearchSearchSettings,
): ResearchSearchSettings {
  const domain =
    raw.domain === undefined
      ? defaults.domain
      : raw.domain === ""
        ? defaults.domain
        : typeof raw.domain === "string"
          ? searchDomain(raw.domain)
          : "";
  const enabled = raw.enabledForAiSearch ?? defaults.enabledForAiSearch;
  const categories = raw.categories ?? defaults.categories;
  const priority = raw.priority ?? defaults.priority;
  if (typeof enabled !== "boolean" || (enabled && !domain))
    throw new RangeError("Некорректные настройки поиска");
  if (
    !Array.isArray(categories) ||
    !categories.length ||
    categories.length > 20 ||
    !categories.every(
      (tag) => typeof tag === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(tag),
    )
  )
    throw new RangeError("Некорректные настройки поиска");
  if (
    typeof priority !== "number" ||
    !Number.isInteger(priority) ||
    Math.abs(priority) > 1000
  )
    throw new RangeError("Некорректные настройки поиска");
  return {
    domain,
    enabledForAiSearch: enabled,
    categories: [...new Set(categories)],
    priority,
  };
}

export function normalizeSearchUrl(value: string) {
  if (
    !value ||
    value.length > 4096 ||
    /[\s\\]/u.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const domain = searchDomain(url.hostname);
    url.hostname = domain;
    url.hash = "";
    // Do not follow redirects or unwrap third-party URLs. Reject redirect wrappers.
    if (
      /\/(?:redirect|redir|away|out)(?:[/.]|$)/i.test(url.pathname) ||
      [...url.searchParams].some(
        ([key, value]) =>
          /^(?:url|target|redirect|redirect_uri|redirect_url|goto|next|continue)$/i.test(
            key,
          ) && /^(?:https?:|\/\/)/i.test(value),
      )
    )
      return null;
    for (const key of [...url.searchParams.keys()])
      if (/^utm_|^(?:gclid|fbclid|yclid)$/i.test(key))
        url.searchParams.delete(key);
    url.searchParams.sort();
    return { url: url.href, domain, key: url.href.replace(/^http:/, "https:") };
  } catch {
    return null;
  }
}
