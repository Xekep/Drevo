const RELOAD_KEY = "drevo:lazy-section-reload";

type ReloadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Разрешает только одну автоматическую перезагрузку для раздела.
 * Это восстанавливает старую открытую вкладку после деплоя, когда её lazy chunk
 * уже исчез из текущего dist, и одновременно не допускает бесконечный reload-loop.
 */
export function shouldReloadLazySection(
  pathname: string,
  storage: ReloadStorage,
): boolean {
  try {
    if (storage.getItem(RELOAD_KEY) === pathname) return false;
    storage.setItem(RELOAD_KEY, pathname);
    return true;
  } catch {
    return false;
  }
}

/** Успешная загрузка раздела снова разрешает одноразовое восстановление. */
export function clearLazySectionReload(
  pathname: string,
  storage: ReloadStorage,
) {
  try {
    if (storage.getItem(RELOAD_KEY) === pathname) storage.removeItem(RELOAD_KEY);
  } catch {
    /* sessionStorage может быть недоступен в жёстком privacy-режиме. */
  }
}
