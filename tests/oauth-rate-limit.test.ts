import test from "node:test";
import assert from "node:assert/strict";
import {
  createOAuthStartLimiter,
  oauthClientKey,
} from "../src/server/oauth-rate-limit.ts";

test("OAuth start limiter blocks one client until the window expires", () => {
  let now = 1000;
  const limiter = createOAuthStartLimiter({
    limit: 3,
    windowMs: 10_000,
    now: () => now,
  });
  assert.equal(limiter.allow("198.51.100.1"), true);
  assert.equal(limiter.allow("198.51.100.1"), true);
  assert.equal(limiter.allow("198.51.100.1"), true);
  assert.equal(limiter.allow("198.51.100.1"), false);
  assert.equal(limiter.allow("198.51.100.2"), true);
  now += 10_000;
  assert.equal(limiter.allow("198.51.100.1"), true);
});

test("OAuth limiter caps remembered client keys", () => {
  const limiter = createOAuthStartLimiter({ maxClients: 2 });
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("b"), true);
  assert.equal(limiter.allow("c"), false);
});

test("OAuth client key trusts only an IP-looking proxy value", () => {
  assert.equal(oauthClientKey("203.0.113.9", "127.0.0.1"), "203.0.113.9");
  assert.equal(oauthClientKey("2001:db8::1", "127.0.0.1"), "2001:db8::1");
  assert.equal(oauthClientKey("spoofed-value", "127.0.0.1"), "127.0.0.1");
  assert.equal(oauthClientKey(undefined, "::1"), "::1");
});
