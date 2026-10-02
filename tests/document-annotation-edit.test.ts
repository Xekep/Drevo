import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import type { DocumentAnnotation } from "../src/shared/document-annotations.ts";

test("document annotation edits preserve identity, reject stale text and enforce author permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-document-edit-"));
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://archive.test";
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const db = app.archive.db;
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const cookies = new Map<string, string>();
    for (const [index, [id, role]] of [
      ["author", "relative"],
      ["other", "relative"],
      ["researcher", "researcher"],
      ["admin", "admin"],
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
    const documentId = randomUUID();
    await db
      .prepare(
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        documentId,
        "Document",
        "document",
        `${documentId}.pdf`,
        1,
        "other",
        new Date().toISOString(),
      );
    const annotation: DocumentAnnotation = {
      id: randomUUID(),
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.1,
      text: "Original",
      authorId: "author",
      authorName: "Author",
      createdAt: new Date().toISOString(),
    };
    const seed = (authorId = "author") =>
      db
        .prepare("UPDATE documents SET annotations=? WHERE id=?")
        .run(JSON.stringify([{ ...annotation, authorId }]), documentId);
    const stored = async (): Promise<DocumentAnnotation[]> =>
      JSON.parse(
        String(
          (
            await db
              .prepare("SELECT annotations FROM documents WHERE id=?")
              .get(documentId)
          )?.annotations,
        ),
      );
    const path = `${base}/api/documents/${documentId}/annotations`;
    const list = async (user: string) =>
      (
        await (
          await fetch(path, {
            headers: { Cookie: cookies.get(user)! },
          })
        ).json()
      ).items as DocumentAnnotation[];
    const patch = (
      user: string,
      body: unknown,
      origin = "https://archive.test",
      id = annotation.id,
    ) =>
      fetch(`${path}/${id}`, {
        method: "PATCH",
        headers: {
          Cookie: cookies.get(user)!,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    await seed();
    for (const user of cookies.keys()) {
      assert.equal((await list(user))[0].canEdit, user === "author", user);
      if (user !== "author") {
        assert.equal(
          (
            await patch(user, {
              expected: "Original",
              text: "Forged",
              authorId: user,
              canEdit: true,
            })
          ).status,
          403,
          user,
        );
        assert.deepEqual(await stored(), [annotation]);
      }
    }
    const edited = await patch("author", {
      expected: "Original",
      text: "  Changed  ",
      page: 8,
      x: 0.9,
      authorId: "admin",
      canEdit: false,
    });
    assert.equal(edited.status, 200, await edited.clone().text());
    assert.deepEqual(await stored(), [{ ...annotation, text: "Changed" }]);
    assert.equal((await edited.json()).items[0].canEdit, true);
    const stale = await patch("author", {
      expected: "Original",
      text: "Overwrite",
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).current, "Changed");
    assert.equal((await stored())[0].text, "Changed");
    const simultaneous = await Promise.all(
      ["First tab", "Second tab"].map((text) =>
        patch("author", { expected: "Changed", text }),
      ),
    );
    assert.deepEqual(
      simultaneous.map((response) => response.status).sort(),
      [200, 409],
    );
    assert.ok(["First tab", "Second tab"].includes((await stored())[0].text));
    await seed();
    for (const body of [
      null,
      { expected: 1, text: "Text" },
      { expected: "Original", text: " \n " },
      { expected: "Original", text: "x".repeat(2001) },
      { expected: "x".repeat(2001), text: "Text" },
    ])
      assert.equal((await patch("author", body)).status, 400);
    assert.deepEqual(await stored(), [annotation]);
    assert.equal(
      (
        await patch(
          "author",
          { expected: "Original", text: "Text" },
          "https://evil.test",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await patch(
          "author",
          { expected: "Original", text: "Text" },
          undefined,
          randomUUID(),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${path}/${annotation.id}`, {
          method: "PATCH",
          headers: {
            Cookie: cookies.get("author")!,
            Origin: "https://archive.test",
          },
          body: "Text",
        })
      ).status,
      415,
    );
    for (const user of ["admin", "researcher"]) {
      await seed(user);
      assert.equal((await list(user))[0].canEdit, true);
      assert.equal(
        (await patch(user, { expected: "Original", text: "Own edit" })).status,
        200,
      );
    }
    for (const author of ["", "deleted-account", "reader"]) {
      await seed(author);
      for (const user of cookies.keys())
        assert.equal((await list(user))[0].canEdit, false);
      assert.equal(
        (
          await patch(author === "reader" ? "reader" : "admin", {
            expected: "Original",
            text: "Text",
          })
        ).status,
        403,
      );
    }
    await seed();
    const longText = "Я".repeat(2000);
    assert.equal(
      (await patch("author", { expected: "Original", text: longText })).status,
      200,
    );
    assert.equal(
      (await patch("author", { expected: longText, text: "Back" })).status,
      200,
    );
    await seed();
    const transaction = db.transaction;
    let downgraded = false;
    db.transaction = async (work, readOnly = false) => {
      if (!readOnly && !downgraded) {
        downgraded = true;
        await db
          .prepare("UPDATE users SET role='reader' WHERE id='author'")
          .run();
      }
      return transaction(work, readOnly);
    };
    try {
      assert.equal(
        (await patch("author", { expected: "Original", text: "Text" })).status,
        403,
      );
      assert.ok(downgraded);
      assert.deepEqual(await stored(), [annotation]);
    } finally {
      db.transaction = transaction;
      await db
        .prepare("UPDATE users SET role='relative' WHERE id='author'")
        .run();
    }
    await db
      .prepare(
        "UPDATE users SET tree_access='common_ancestors' WHERE id='author'",
      )
      .run();
    assert.equal(
      (await patch("author", { expected: "Original", text: "Text" })).status,
      404,
    );
    assert.deepEqual(await stored(), [annotation]);
    const audit = await db
      .prepare(
        "SELECT actor_id FROM audit_entries WHERE action='Изменён комментарий к документу'",
      )
      .all();
    assert.equal(audit.length, 6, "only successful edits are audited");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
  }
});
