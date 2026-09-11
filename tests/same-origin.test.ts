import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { isSameOriginRequest } from "../src/server/same-origin.ts";

function request(headers: IncomingMessage["headers"]) {
  return { headers } as Pick<IncomingMessage, "headers">;
}

test("same-origin request accepts missing or matching Origin", () => {
  assert.equal(
    isSameOriginRequest(request({ host: "127.0.0.1:3000" })),
    true,
  );
  assert.equal(
    isSameOriginRequest(
      request({
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
      }),
    ),
    true,
  );
  assert.equal(
    isSameOriginRequest(
      request({ host: "drevo.local", origin: "https://drevo.example" }),
      "https://drevo.example",
    ),
    true,
  );
});

test("same-origin request rejects mismatched Origin and explicit cross-site", () => {
  assert.equal(
    isSameOriginRequest(
      request({ host: "drevo.local", origin: "https://evil.example" }),
      "https://drevo.example",
    ),
    false,
  );
  assert.equal(
    isSameOriginRequest(
      request({
        host: "drevo.local",
        origin: "https://drevo.example",
        "sec-fetch-site": "cross-site",
      }),
      "https://drevo.example",
    ),
    false,
  );
  assert.equal(
    isSameOriginRequest(
      request({ host: "drevo.local", origin: "null" }),
      "https://drevo.example",
    ),
    false,
  );
});

test("same-site and same-origin Sec-Fetch-Site keep matching requests allowed", () => {
  for (const site of ["same-site", "same-origin"] as const)
    assert.equal(
      isSameOriginRequest(
        request({
          host: "drevo.local",
          origin: "https://drevo.example",
          "sec-fetch-site": site,
        }),
        "https://drevo.example",
      ),
      true,
    );
});
