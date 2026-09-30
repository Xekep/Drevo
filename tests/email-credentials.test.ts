import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashAccountPassword,
  normalizeAccountEmail,
  validateAccountPassword,
  verifyAccountPassword,
} from "../src/server/email-credentials.ts";

test("email credentials normalize consistently without accepting malformed input", () => {
  assert.equal(
    normalizeAccountEmail(" Person@Example.org "),
    "person@example.org",
  );
  assert.throws(() => normalizeAccountEmail("person@invalid"));
  assert.throws(() => normalizeAccountEmail("person..name@example.org"));
  assert.throws(() => validateAccountPassword("short"));
});

test("password hashes use a random salt and reject a different password", async () => {
  const password = validateAccountPassword("correct horse battery staple");
  const first = await hashAccountPassword(password);
  const second = await hashAccountPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyAccountPassword(password, first), true);
  assert.equal(await verifyAccountPassword("different password", first), false);
  assert.equal(await verifyAccountPassword(password, "invalid"), false);
});
