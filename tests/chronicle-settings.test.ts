import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { chronicleSettingsHttp } from "../src/server/chronicle-settings-http.ts";
import type { createAuth } from "../src/server/auth.ts";
import {
  defaultChronicleSettings,
  chronicleEffects,
  chronicleFields,
  chroniclePresets,
  validateChronicleSettings,
} from "../src/shared/chronicle-settings.ts";

test("all five reference effects and presets validate; unsafe or unsupported settings are rejected", () => {
  assert.equal(Object.keys(chronicleFields).length, 31);
  assert.equal(Object.keys(chronicleEffects).length, 5);
  for (const [currentEffect, presets] of Object.entries(chroniclePresets))
    for (const [currentEffectPreset, values] of Object.entries(presets))
      assert.equal(
        validateChronicleSettings({
          ...defaultChronicleSettings,
          ...values,
          currentEffect,
          currentEffectPreset,
        }).currentEffect,
        currentEffect,
      );
  for (const bad of [
    null,
    [],
    { ...defaultChronicleSettings, currentEffect: "unknown" },
    { ...defaultChronicleSettings, currentEffectPreset: "unknown" },
    { ...defaultChronicleSettings, admin: true },
    { ...defaultChronicleSettings, autoSlideSpeed: 0 },
    { ...defaultChronicleSettings, transitionDuration: Infinity },
    { ...defaultChronicleSettings, glassBubbleClarity: NaN },
    { ...defaultChronicleSettings, rippleAmplitude: "0.1" },
  ])
    assert.throws(() => validateChronicleSettings(bad), RangeError);
});

test("global settings persist, serialize competing administrators and reject cross-origin or malformed writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-chronicle-settings-")),
    file = join(directory, "test.sqlite");
  let app = await startServer(0, file, true);
  const address = () =>
    `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const initial = await (
      await fetch(`${address()}/api/chronicle-settings`)
    ).json();
    assert.deepEqual(initial, {
      version: 0,
      settings: defaultChronicleSettings,
      canConfigure: true,
    });
    const save = (
      settings: unknown,
      version: number,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${address()}/api/chronicle-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ settings, version }),
      });
    const updated = {
      ...defaultChronicleSettings,
      currentEffect: "frost",
      currentEffectPreset: "Heavy",
      ...chroniclePresets.frost.Heavy,
      autoSlideSpeed: 7500,
    };
    assert.equal(
      (await save(updated, 0, { Origin: "https://other.invalid" })).status,
      403,
    );
    assert.equal(
      (await save({ ...updated, transitionDuration: -1 }, 0)).status,
      400,
    );
    assert.equal((await save(updated, -1)).status, 400);
    assert.equal((await save(updated, 0)).status, 200);
    assert.equal((await save(defaultChronicleSettings, 0)).status, 409);
    const results = await Promise.all([
      save(updated, 1),
      save(defaultChronicleSettings, 1),
    ]);
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [200, 409],
    );
    const saved = await (
      await fetch(`${address()}/api/chronicle-settings`)
    ).json();
    assert.equal(saved.version, 2);
    assert.equal(
      (await fetch(`${address()}/api/chronicle-settings`, { method: "DELETE" }))
        .status,
      405,
    );
    await app.close();
    app = await startServer(0, file, true);
    assert.deepEqual(
      await (await fetch(`${address()}/api/chronicle-settings`)).json(),
      saved,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readers cannot open privileged settings or write; role checks run again after reading the body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-chronicle-rights-"));
  const app = await startServer(0, join(directory, "test.sqlite"), true);
  let readable = true,
    platform = false,
    calls = 0,
    revoke = false;
  const handler = chronicleSettingsHttp({
    db: app.archive.db,
    auth: {
      canRead: async () => readable,
      isPlatformAdmin: async () => platform && (!revoke || ++calls === 1),
      currentUser: async () => ({
        id: "owner",
        name: "Владелец древа",
        role: "admin",
        approved: true,
      }),
      accountSession: async () => null,
    } as unknown as Awaited<ReturnType<typeof createAuth>>,
  });
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url!, `http://${req.headers.host}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/chronicle-settings`;
  const save = () =>
    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 0, settings: defaultChronicleSettings }),
    });
  try {
    assert.equal((await (await fetch(url)).json()).canConfigure, false);
    assert.equal(
      (await save()).status,
      403,
      "archive-owner role alone does not permit a global mutation",
    );
    platform = true;
    revoke = true;
    assert.equal((await save()).status, 403);
    assert.equal(calls, 2);
    assert.equal((await (await fetch(url)).json()).version, 0);
    readable = false;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await save()).status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
