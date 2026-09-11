import test from "node:test";
import assert from "node:assert/strict";
import {
  clearLazySectionReload,
  shouldReloadLazySection,
} from "../src/components/lazy-section-recovery.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("lazy section recovery reloads once per route and resets after success", () => {
  const storage = new MemoryStorage();

  assert.equal(shouldReloadLazySection("/people", storage), true);
  assert.equal(
    shouldReloadLazySection("/people", storage),
    false,
    "повторная ошибка на том же маршруте не создаёт reload-loop",
  );
  assert.equal(
    shouldReloadLazySection("/photos", storage),
    true,
    "другой раздел получает собственную попытку восстановления",
  );

  clearLazySectionReload("/photos", storage);
  assert.equal(
    shouldReloadLazySection("/photos", storage),
    true,
    "после успешной загрузки восстановление снова разрешено",
  );
});

test("lazy section recovery does not force reload when storage is unavailable", () => {
  const brokenStorage = {
    getItem() {
      throw new Error("storage denied");
    },
    setItem() {
      throw new Error("storage denied");
    },
    removeItem() {
      throw new Error("storage denied");
    },
  };

  assert.equal(shouldReloadLazySection("/people", brokenStorage), false);
  assert.doesNotThrow(() => clearLazySectionReload("/people", brokenStorage));
});
