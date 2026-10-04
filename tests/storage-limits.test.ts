import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { openArchive } from "../src/server/database.ts";
import { startServer } from "../src/server/index.ts";
import {
  DEFAULT_STORAGE_LIMITS,
  parseStorageLimits,
} from "../src/shared/storage-limits.ts";
import {
  readStorageLimits,
  writeStorageLimits,
  userStorageBytes,
} from "../src/server/storage-limits.ts";
import { uploadQuota, UploadQuotaError } from "../src/server/upload-quota.ts";
import { registerMediaUpload } from "../src/server/media-access.ts";
import { releaseAttachedMediaGrants } from "../src/server/postgres-media-quota.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

const admin: ArchiveUser = {
  id: "admin",
  name: "Admin",
  role: "admin",
  approved: true,
  createdAt: "2026-09-30T00:00:00Z",
};

test("storage limits count each uploader, reservations, current roles and distinct originals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-storage-"));
  const archive = await openArchive(join(dir, "db.sqlite"), {
    title: "Test",
    description: "",
    people: [],
    demo: false,
  });
  const db = archive.db;
  try {
    for (const [id, role] of [
      ["admin", "admin"],
      ["one", "relative"],
      ["two", "researcher"],
      ["reader", "reader"],
    ])
      await db
        .prepare("INSERT INTO users(id,name,role,approved) VALUES(?,?,?,1)")
        .run(id, id, role);
    const limits = { ...DEFAULT_STORAGE_LIMITS, relative: 1, researcher: 2 };
    await db.transaction(() => writeStorageLimits(db, limits, admin));
    assert.deepEqual(await readStorageLimits(db), limits);
    await registerMediaUpload(db, "/media/one.jpg", "one", 300_000);
    await db
      .prepare(
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES('d','d','d','d.pdf',200000,'one','now')",
      )
      .run();
    await db
      .prepare("INSERT INTO people(id,data) VALUES('p',?)")
      .run(JSON.stringify({ id: "p", photo: "/media/one.jpg" }));
    await db
      .prepare("INSERT INTO photos(id,data) VALUES('photo',?)")
      .run(JSON.stringify({ id: "photo", url: "/media/one.jpg" }));
    await db.transaction(() => releaseAttachedMediaGrants(db));
    assert.equal(await userStorageBytes(db, "one"), 500_000);
    const quota = uploadQuota(db);
    const outcomes = await Promise.allSettled([
      quota.acquire("one", 400_000, 1e12),
      quota.acquire("one", 400_000, 1e12),
    ]);
    assert.equal(
      outcomes.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const denied = outcomes.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    assert.ok(denied.reason instanceof UploadQuotaError);
    assert.equal(denied.reason.status, 507);
    await (
      await quota.acquire("two", 1_500_000, 1e12)
    )();
    for (const result of outcomes)
      if (result.status === "fulfilled") await result.value();
    await assert.rejects(quota.acquire("reader", 1, 1e12), UploadQuotaError);
    await db.prepare("UPDATE users SET role='researcher' WHERE id='one'").run();
    await (
      await quota.acquire("one", 1_500_000, 1e12)
    )();
    await db.prepare("DELETE FROM photos WHERE id='photo'").run();
    assert.equal(
      await userStorageBytes(db, "one"),
      500_000,
      "portrait keeps the same original in use",
    );
    await db.prepare("DELETE FROM people WHERE id='p'").run();
    assert.equal(
      await userStorageBytes(db, "one"),
      200_000,
      "last reference frees image capacity",
    );
    const release = await quota.acquire("one", 500_000, 1e12);
    await db.transaction(() =>
      writeStorageLimits(db, { ...limits, researcher: 0 }, admin),
    );
    await assert.rejects(
      registerMediaUpload(db, "/media/new.jpg", "one", 500_000),
      UploadQuotaError,
    );
    assert.equal(
      await db
        .prepare("SELECT 1 FROM media_originals WHERE url='/media/new.jpg'")
        .get(),
      undefined,
    );
    assert.equal(
      await userStorageBytes(db, "one"),
      200_000,
      "lowering limits preserves existing documents",
    );
    await release();
    assert.equal(parseStorageLimits({ ...limits, relative: -1 }), null);
    assert.equal(parseStorageLimits({ ...limits, relative: 1.2 }), null);
    assert.equal(parseStorageLimits({ ...limits, relative: 10241 }), null);
  } finally {
    await archive.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attached citation grants release across people, relations and unions", async () => {
  const archive = await openArchive(":memory:", {
    title: "Test", description: "", people: [], demo: false,
  });
  const db = archive.db;
  try {
    await db.prepare("INSERT INTO users(id,name,role,approved) VALUES('admin','Admin','admin',1)").run();
    for (const name of ["person", "relation", "union", "pending"])
      await registerMediaUpload(db, `/media/${name}.jpg`, "admin", 10);
    await db.prepare("INSERT INTO people(id,data) VALUES('a',?)").run(JSON.stringify({
      sources: [{ url: "/media/person.jpg#page=1" }],
    }));
    await db.prepare("INSERT INTO people(id,data) VALUES('b',?)").run("{}");
    await db.prepare("INSERT INTO relations(id,source,target,type,sources) VALUES('r','a','b','parent',?)")
      .run(JSON.stringify([{ url: "/media/relation.jpg?page=2" }]));
    await db.prepare("INSERT INTO family_unions(id,participant_a,participant_b,data) VALUES('u','a','b',?)")
      .run(JSON.stringify({ sources: [{ url: "/media/union.jpg" }] }));
    await db.transaction(() => releaseAttachedMediaGrants(db));
    const grants = await db.prepare("SELECT url FROM media_upload_grants ORDER BY url").all();
    assert.deepEqual(grants.map((row) => row.url), ["/media/pending.jpg"]);
  } finally {
    await archive.close();
  }
});

test("lowering a storage limit still allows attaching an already-counted upload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-storage-downgrade-"));
  const archive = await openArchive(join(dir, "db.sqlite"), {
    title: "Test", description: "", people: [], demo: false,
  });
  const db = archive.db;
  try {
    await db.prepare("INSERT INTO users(id,name,role,approved) VALUES('admin','Admin','admin',1)").run();
    await db.transaction(() => writeStorageLimits(db, { ...DEFAULT_STORAGE_LIMITS, admin: 1 }, admin));
    await registerMediaUpload(db, "/media/pending-photo.jpg", "admin", 800_000);
    assert.equal(await userStorageBytes(db, "admin"), 800_000);
    await db.transaction(() => writeStorageLimits(db, { ...DEFAULT_STORAGE_LIMITS, admin: 0 }, admin));
    const before = await archive.read();
    const saved = await archive.appendPhoto({ id: "pending-photo", url: "/media/pending-photo.jpg",
      title: "", tags: [] }, before.revision, admin);
    assert.equal(saved.family.photos?.length, 1,
      "attaching a reserved original does not add storage after downgrade");
    assert.equal(await userStorageBytes(db, "admin"), 800_000);
    await assert.rejects(registerMediaUpload(db, "/media/extra-photo.jpg", "admin", 1),
      UploadQuotaError, "a genuinely new byte remains forbidden");
  } finally {
    await archive.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PDF accepts 100 MiB, rejects larger uploads and reserves actual small request size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-pdf-limit-"));
  const app = await startServer(0, join(dir, "db.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = {
    "Content-Type": "application/pdf",
    "X-Document-Metadata": encodeURIComponent(
      JSON.stringify({ title: "Large", personIds: [] }),
    ),
  };
  try {
    const large = Buffer.alloc(100 * 1024 * 1024, 32);
    large.write("%PDF-1.4\n%%EOF\n");
    const response = await fetch(base + "/api/documents", {
      method: "POST",
      headers,
      body: large,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const { id } = await response.json();
    assert.equal(
      (await (await fetch(base + `/api/documents/${id}`)).json()).size,
      large.length,
    );
    const oversized = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          base + "/api/documents",
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Length": String(large.length + 1),
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(oversized, 413);
    const oversizedTiff = await fetch(base + "/api/documents", {
      method: "POST",
      headers: { ...headers, "Content-Type": "image/tiff" },
      body: large.subarray(0, 50 * 1024 * 1024 + 1),
    });
    assert.equal(oversizedTiff.status, 413, "TIFF remains limited to 50 MiB");
    assert.match((await oversizedTiff.json()).error, /TIFF.*50/);
    await fetch(base + `/api/documents/${id}`, { method: "DELETE" });
    const limits = { ...DEFAULT_STORAGE_LIMITS, admin: 1 };
    await app.archive.db.transaction(() =>
      writeStorageLimits(app.archive.db, limits, { ...admin, id: "local" }),
    );
    const small = await fetch(base + "/api/documents", {
      method: "POST",
      headers,
      body: Buffer.from("%PDF-1.4\n%%EOF\n"),
    });
    assert.equal(
      small.status,
      201,
      "a tiny PDF does not reserve the full 100 MiB",
    );
    await app.archive.db.transaction(() =>
      writeStorageLimits(
        app.archive.db,
        { ...limits, admin: 0 },
        { ...admin, id: "local" },
      ),
    );
    assert.equal(
      (
        await fetch(base + "/api/documents", {
          method: "POST",
          headers,
          body: Buffer.from("%PDF-1.4\n%%EOF\n"),
        })
      ).status,
      507,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage administration rejects non-admins, cross-origin writes and stale edits", async () => {
  const previous = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const dir = mkdtempSync(join(tmpdir(), "drevo-storage-admin-"));
  const app = await startServer(0, join(dir, "db.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    for (const [id, role] of [
      ["admin", "admin"],
      ["reader", "reader"],
    ]) {
      await app.archive.db
        .prepare("INSERT INTO users(id,name,role,approved) VALUES(?,?,?,1)")
        .run(id, id, role);
      await app.archive.db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        )
        .run(
          createHash("sha256")
            .update((id === "admin" ? "a" : "b").repeat(64))
            .digest("hex"),
          id,
          Date.now() + 60_000,
        );
    }
    const call = (
      who: string,
      method = "GET",
      body?: unknown,
      origin = "https://archive.test",
    ) =>
      fetch(base + "/api/settings/storage", {
        method,
        headers: {
          Cookie: `drevo_session=${(who === "admin" ? "a" : "b").repeat(64)}`,
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const expected = await (await call("admin")).json();
    const body = {
      expected,
      next: { ...expected, relative: 500, researcher: 2000 },
    };
    assert.equal((await call("reader")).status, 403);
    assert.equal((await call("reader", "PUT", body)).status, 403);
    assert.equal(
      (await call("admin", "PUT", body, "https://evil.test")).status,
      403,
    );
    assert.equal((await call("admin", "PUT", body)).status, 200);
    assert.equal((await call("admin", "PUT", body)).status, 409);
    assert.deepEqual(await (await call("admin")).json(), body.next);
    assert.equal(
      (
        await call("admin", "PUT", {
          expected: body.next,
          next: { ...body.next, relative: -1 },
        })
      ).status,
      400,
    );
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
