import assert from "node:assert/strict";
import test from "node:test";
import { discoveryArchiveId } from "../src/server/discovery-archive-id.ts";

test("UUID archive routes keep their identity and legacy routes get a permanent UUID", () => {
  const actual = "8a19236c-32d8-48ca-83d0-634794b478b9";
  assert.equal(discoveryArchiveId(actual), actual);
  assert.equal(discoveryArchiveId(actual.toUpperCase()), actual);
  const legacy = discoveryArchiveId("legacy-primary");
  assert.equal(legacy, "b4625b46-aa17-8058-89c5-e6ee7accdd6c", "published links must keep this namespace and encoding");
  assert.match(legacy, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(discoveryArchiveId("legacy-primary"), legacy);
  assert.notEqual(discoveryArchiveId("another-archive"), legacy);
});
