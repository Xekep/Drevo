import assert from "node:assert/strict";
import test from "node:test";
import { safeRequestRoute } from "../src/server/safe-request-route.ts";

test("share bearer tokens stay out of root and selected-archive request logs", () => {
  for (const prefix of ["", "/a/private-tree"]) {
    assert.equal(
      safeRequestRoute(`${prefix}/s/private-token`),
      "/s/[redacted]",
    );
    assert.equal(
      safeRequestRoute(
        `${prefix}/api/shared/private-token/portrait/person?check=1`,
      ),
      "/api/shared/[redacted]",
    );
  }
  assert.equal(
    safeRequestRoute("/a/private-tree/api/session?secret=1"),
    "/a/private-tree/api/session",
  );
  assert.equal(
    safeRequestRoute("/join/private-tree/private-token"),
    "/join/[redacted]",
  );
});
