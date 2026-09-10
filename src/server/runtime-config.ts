/** На опубликованном сервере отсутствие адреса не должно включать локального администратора. */
export function assertProductionOrigin(production: boolean, value?: string) {
  if (!production) return;
  let url: URL;
  try {
    url = new URL(value || "");
  } catch {
    throw new Error(
      "Для production задайте PUBLIC_ORIGIN: https://домен без пути.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new Error(
      "PUBLIC_ORIGIN для production должен быть HTTPS-адресом без пути, параметров и учётных данных.",
    );
}
