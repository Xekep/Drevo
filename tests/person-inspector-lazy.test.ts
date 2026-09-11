import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/components/person-inspector.tsx", "utf8");

test("person inspector keeps admin history out of the eager bundle", () => {
  assert.match(source, /import \{ PersonFullView \} from "\.\/person-full-view"/);
  assert.doesNotMatch(source, /import \{ AuditLog \} from "\.\/audit-log"/);
  assert.match(source, /const AuditLog = lazy/);
  assert.match(source, /import\("\.\/audit-log"\)/);
  assert.match(source, /loadLazyModule/);
  assert.match(source, /LazyChunkBoundary/);
  assert.match(source, /<Suspense/);
});
