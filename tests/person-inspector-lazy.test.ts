import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/components/person-inspector.tsx", "utf8");

test("person inspector keeps optional history and full view out of the eager bundle", () => {
  assert.doesNotMatch(source, /import \{ PersonFullView \} from "\.\/person-full-view"/);
  assert.doesNotMatch(source, /import \{ AuditLog \} from "\.\/audit-log"/);
  assert.match(source, /const AuditLog = lazy/);
  assert.match(source, /import\("\.\/audit-log"\)/);
  assert.match(source, /const PersonFullView = lazy/);
  assert.match(source, /import\("\.\/person-full-view"\)/);
  assert.match(source, /loadLazyModule/);
  assert.match(source, /LazyChunkBoundary/);
  assert.match(source, /<Suspense/);
});
