const RELOAD_KEY = "drevo:lazy-section-reload";

type ReloadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Разрешает только одну автоматическую перезагрузку для lazy-модуля.
 * Это восстанавливает старую открытую вкладку после деплоя, когда её chunk
 * уже исчез из текущего dist, и одновременно не допускает бесконечный reload-loop.
 */
export function shouldReloadLazySection(
  key: string,
  storage: ReloadStorage,
): boolean {
  try {
    if (storage.getItem(RELOAD_KEY) === key) return false;
    storage.setItem(RELOAD_KEY, key);
    return true;
  } catch {
    return false;
  }
}

/** Успешная загрузка снова разрешает одноразовое восстановление этого chunk. */
export function clearLazySectionReload(key: string, storage: ReloadStorage) {
  try {
    if (storage.getItem(RELOAD_KEY) === key) storage.removeItem(RELOAD_KEY);
  } catch {
    /* sessionStorage может быть недоступен в жёстком privacy-режиме. */
  }
}

/**
 * Загружает lazy-модуль и один раз обновляет устаревшую вкладку, если после
 * деплоя браузер запросил уже удалённый hashed chunk.
 */
export async function loadLazyModule<T>(
  loader: () => Promise<T>,
  recoveryId: string,
): Promise<T> {
  const key = `${window.location.pathname}:${recoveryId}`;
  try {
    const module = await loader();
    clearLazySectionReload(key, window.sessionStorage);
    return module;
  } catch (error) {
    if (shouldReloadLazySection(key, window.sessionStorage)) {
      window.location.reload();
      return await new Promise<T>(() => {});
    }
    throw error;
  }
}
