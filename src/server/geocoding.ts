import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  photonResult,
  historicalMatches,
  historicalCandidates,
  placeKey,
  placeSearch,
  type PlaceResult,
} from "../domain/places.ts";

/** Один общий последовательный поиск; постоянный кэш не зависит от посетителя. */
export function geocodingStore(
  db: DatabaseSync,
  fetcher: typeof fetch = fetch,
  interval = 1200,
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS geocode_cache (query TEXT PRIMARY KEY, data TEXT NOT NULL, saved_at INTEGER NOT NULL) STRICT",
  );
  const pending = new Map<string, Promise<PlaceResult>>();
  let tail = Promise.resolve(),
    last = 0,
    closed = false,
    pauseUntil = 0;
  let day = new Date().toISOString().slice(0, 10),
    requests = 0;
  function locate(text: string) {
    const query = placeSearch(text),
      provider = process.env.GEOCODER_URL || "https://photon.komoot.io/api/",
      wiki =
        process.env.HISTORICAL_GEOCODER_URL ||
        "https://www.wikidata.org/w/api.php",
      key = provider + ":" + wiki + ":" + placeKey(query);
    if (closed || query.length < 2 || query.length > 250)
      return Promise.reject(
        new Error("Укажите название населённого пункта (до 250 символов)"),
      );
    const cached = db
      .prepare("SELECT data,saved_at FROM geocode_cache WHERE query=?")
      .get(key);
    if (cached && Date.now() - Number(cached.saved_at) < 180 * 86400000)
      return Promise.resolve(JSON.parse(String(cached.data)) as PlaceResult);
    if (pending.has(key)) return pending.get(key)!;
    if (pending.size >= 32)
      return Promise.reject(
        new Error("Поиск мест занят. Повторите немного позже."),
      );
    const result = tail.then(async () => {
      async function request(url: URL) {
        if (Date.now() < pauseUntil)
          throw new Error(
            "Справочник временно ограничил поиск. Повторите позже.",
          );
        await delay(Math.max(0, interval - (Date.now() - last)));
        if (closed) throw new Error("Поиск остановлен");
        const today = new Date().toISOString().slice(0, 10);
        if (today !== day) {
          day = today;
          requests = 0;
        }
        if (++requests > 1000)
          throw new Error("Лимит поиска мест на сегодня исчерпан");
        last = Date.now();
        const response = await fetcher(url, {
          headers: {
            "User-Agent": "Drevo/1.0 (+https://drevo.kiiko.ru)",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (!response.ok) {
          if (response.status === 429 || response.status === 503)
            pauseUntil =
              Date.now() +
              Math.max(
                60000,
                Math.min(
                  3600000,
                  (Number(response.headers.get("Retry-After")) || 60) * 1000,
                ),
              );
          throw new Error("Сервис поиска мест временно недоступен");
        }
        return response.json();
      }
      const url = new URL(provider);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "8");
      url.searchParams.set("osm_tag", "place");
      let data: PlaceResult = { query, candidates: [] },
        photonFailed = false;
      try {
        data = photonResult(query, await request(url));
      } catch {
        photonFailed = true;
      }
      if (!data.automatic) {
        const search = new URL(wiki);
        search.search = new URLSearchParams({
          action: "wbsearchentities",
          search: query,
          language: "ru",
          uselang: "ru",
          type: "item",
          format: "json",
          limit: "8",
          maxlag: "5",
        }).toString();
        const matches = historicalMatches(query, await request(search));
        if (matches.length) {
          const entities = new URL(wiki);
          entities.search = new URLSearchParams({
            action: "wbgetentities",
            ids: matches.map((p) => p.id).join("|"),
            props: "claims",
            format: "json",
            maxlag: "5",
          }).toString();
          const historic = historicalCandidates(
            matches,
            await request(entities),
          );
          // Неоднозначность обычного геопоиска не снимается первым ответом справочника.
          const exactCurrent = data.candidates.filter(
            (p) => placeKey(p.name) === placeKey(query),
          );
          data = {
            ...data,
            candidates: [...historic, ...data.candidates],
            ...(historic.length === 1 &&
            matches.length === 1 &&
            exactCurrent.length < 2
              ? { automatic: historic[0] }
              : {}),
          };
        } else if (photonFailed)
          throw new Error("Поиск мест временно недоступен. Повторите позже.");
      }
      if (closed) throw new Error("Поиск остановлен");
      db.prepare("INSERT OR REPLACE INTO geocode_cache VALUES(?,?,?)").run(
        key,
        JSON.stringify(data),
        Date.now(),
      );
      db.exec(
        "DELETE FROM geocode_cache WHERE query NOT IN (SELECT query FROM geocode_cache ORDER BY saved_at DESC LIMIT 5000)",
      );
      return data;
    });
    pending.set(key, result);
    tail = result.then(
      () => {
        pending.delete(key);
      },
      () => {
        pending.delete(key);
      },
    );
    return result;
  }
  return {
    locate,
    close: () => {
      closed = true;
    },
  };
}
