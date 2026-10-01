import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { DocumentAnnotation } from "../src/shared/document-annotations.ts";

test("document comments allow moderators to remove any accessible comment and relatives only their own", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-document-moderation-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const db = app.archive.db;
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const cookies = new Map<string, string>();
    for (const [index, [id, role]] of [
      ["admin", "admin"],
      ["researcher", "researcher"],
      ["author", "relative"],
      ["relative", "relative"],
      ["reader", "reader"],
    ].entries()) {
      await db
        .prepare("INSERT INTO users(id,name,role,approved) VALUES(?,?,?,1)")
        .run(id, id, role);
      const token = String(index + 1).repeat(64);
      await db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        )
        .run(
          createHash("sha256").update(token).digest("hex"),
          id,
          Date.now() + 60_000,
        );
      cookies.set(id, `drevo_session=${token}`);
    }
    const id = randomUUID();
    // The document owner must not gain permission to delete someone else's annotation.
    await db
      .prepare(
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        "Document",
        "document",
        `${id}.pdf`,
        1,
        "relative",
        new Date().toISOString(),
      );
    const path = `/api/documents/${id}/annotations`;
    const request = (
      user: string,
      suffix = "",
      method = "GET",
      origin = "https://archive.test",
    ) =>
      fetch(base + path + suffix, {
        method,
        headers: { Cookie: cookies.get(user) || "", Origin: origin },
      });
    const annotation: DocumentAnnotation = {
      id: randomUUID(),
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.1,
      text: "Comment",
      authorId: "author",
      authorName: "Author",
      createdAt: new Date().toISOString(),
    };
    const seed = (authorId = "author") =>
      db
        .prepare("UPDATE documents SET annotations=? WHERE id=?")
        .run(JSON.stringify([{ ...annotation, authorId }]), id);
    const remaining = async () =>
      JSON.parse(
        String(
          (
            await db
              .prepare("SELECT annotations FROM documents WHERE id=?")
              .get(id)
          )?.annotations,
        ),
      );
    for (const [user, allowed] of [
      ["admin", true],
      ["researcher", true],
      ["author", true],
      ["relative", false],
      ["reader", false],
    ] as const) {
      await seed();
      const response = await request(user);
      assert.equal(response.status, 200);
      const items = (await response.json()).items as DocumentAnnotation[];
      assert.equal(
        items[0].canDelete,
        allowed,
        `${user}: show delete according to server permissions`,
      );
      const removed = await request(user, `/${annotation.id}`, "DELETE");
      assert.equal(removed.status, allowed ? 200 : 403, user);
      assert.equal((await remaining()).length, allowed ? 0 : 1);
    }
    await seed("reader");
    assert.equal(
      (
        (await (await request("reader")).json()).items as DocumentAnnotation[]
      )[0].canDelete,
      false,
    );
    assert.equal(
      (await request("reader", `/${annotation.id}`, "DELETE")).status,
      403,
    );
    // Imported annotations can have no local author account; moderators can still remove them.
    for (const user of ["researcher", "admin"]) {
      await seed("");
      assert.equal(
        (await request(user, `/${annotation.id}`, "DELETE")).status,
        200,
      );
    }
    await seed();
    assert.equal(
      (
        await request(
          "researcher",
          `/${annotation.id}`,
          "DELETE",
          "https://evil.test",
        )
      ).status,
      403,
    );
    assert.equal((await remaining()).length, 1);
    const transaction = db.transaction;
    let downgraded = false;
    db.transaction = async (work, readOnly = false) => {
      if (!readOnly && !downgraded) {
        downgraded = true;
        await db
          .prepare("UPDATE users SET role='relative' WHERE id='researcher'")
          .run();
      }
      return transaction(work, readOnly);
    };
    try {
      assert.equal(
        (await request("researcher", `/${annotation.id}`, "DELETE")).status,
        403,
      );
      assert.ok(downgraded);
      assert.equal((await remaining()).length, 1);
    } finally {
      db.transaction = transaction;
      await db
        .prepare("UPDATE users SET role='researcher' WHERE id='researcher'")
        .run();
    }
    // Moderation never grants access to documents outside the user's visible branch.
    await db
      .prepare(
        "UPDATE users SET tree_access='common_ancestors' WHERE id='researcher'",
      )
      .run();
    assert.equal((await request("researcher")).status, 404);
    assert.equal(
      (await request("researcher", `/${annotation.id}`, "DELETE")).status,
      404,
    );
    assert.equal((await remaining()).length, 1);
    const audit = await db
      .prepare(
        "SELECT actor_id FROM audit_entries WHERE action='Удалён комментарий к документу'",
      )
      .all();
    assert.ok(audit.some((row) => row.actor_id === "researcher"));
    assert.ok(
      audit.every((row) =>
        ["admin", "researcher", "author"].includes(String(row.actor_id)),
      ),
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
  }
});
