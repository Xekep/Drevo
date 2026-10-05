import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type pg from "pg";
import type { Family } from "../../src/domain/types.ts";
import { openArchive } from "../../src/server/database.ts";
import { startServer } from "../../src/server/index.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { databaseBackupBytes } from "../helpers/database-backup.ts";

export async function verifyRestoreGuard({
  client, source, family, ownerHeaders, restoreBytes, selectedBase, rootArchive,
}: {
  client: pg.Client;
  source: string;
  family: Family;
  ownerHeaders: Record<string, string>;
  restoreBytes: Buffer<ArrayBuffer>;
  selectedBase: string;
  rootArchive: Awaited<ReturnType<typeof openArchive>>;
}) {
  const guardedOwnerId = "restore-guard-owner";
  let guardedOwnerToken: string | undefined;
  let grantCreated = false;
  let started: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    // Keep the restore concurrency checks in their own archive: later fixtures
    // include cards by other authors, which cannot be replaced by this actor.
    const guardedArchiveId = "restore-guard-test";
    const guardedSuccessorId = "restore-guard-successor";
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [guardedArchiveId]);
    await client.query(`INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version)
      VALUES($1,'Restore guard','',false,0,18)`, [guardedArchiveId]);
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Restore guard owner',$2)",
      [guardedOwnerId, new Date().toISOString()]);
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Restore guard successor',$2)",
      [guardedSuccessorId, new Date().toISOString()]);
    await client.query("INSERT INTO account_tiers(account_id,full_access) VALUES($1,true)", [guardedOwnerId]);
    await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
      VALUES($1,$2,'admin',true,'all')`, [guardedArchiveId, guardedOwnerId]);
    await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
      VALUES($1,$2,'relative',true,'all')`, [guardedArchiveId, guardedSuccessorId]);
    await client.query("INSERT INTO archive_owners(archive_id,user_id) VALUES($1,$2)",
      [guardedArchiveId, guardedOwnerId]);
    await client.query("INSERT INTO platform_admins(account_id) VALUES($1)", [guardedOwnerId]);
    grantCreated = true;
    // The existing platform administrator is an approved editor here, while
    // ownership belongs to a different account to respect one-tree-per-owner.
    await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
      VALUES($1,'owner','admin',true,'all')`, [guardedArchiveId]);
    await client.query("INSERT INTO people(id,data) VALUES('person-a',$1)",
      [JSON.stringify(family.people[0])]);
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    const guardedApp = await startServer(0, source, true, undefined, undefined, guardedArchiveId);
    started = guardedApp;
    const guardedBase = `http://127.0.0.1:${(guardedApp.server.address() as { port: number }).port}`;
    const guardedUploads = join(dirname(guardedApp.archive.db.file), "uploads");
    const guardBeforeComments = await guardedApp.archive.read();
    const guardWithRemovedPerson = structuredClone(guardBeforeComments.family);
    guardWithRemovedPerson.people.push({ ...family.people[0], id: "restore-comment-removed",
      name: "Removed" });
    await guardedApp.archive.write(guardWithRemovedPerson, guardBeforeComments.revision);
    await guardedApp.archive.db.prepare("",
      "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,'owner',1000,?)")
      .run("person-a", "restore-comment-retained");
    await guardedApp.archive.db.prepare("",
      "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,'owner',1000,?)")
      .run("restore-comment-removed", "restore-comment-lost");
    // A platform grant can be revoked while a restore is copying staged media.
    // The final grant check must run inside archive.write's transaction and lock
    // the grant until commit, without holding that lock during file copying.
    guardedOwnerToken = newSessionToken();
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [sessionTokenHash(guardedOwnerToken), guardedOwnerId, Date.now() + 10 * 60_000]);
    const formerAdminRestoreHeaders = { ...ownerHeaders, "X-Drevo-Restore": "1" };
    assert.equal((await fetch(guardedBase + "/api/restore/preview", {
      method: "POST", headers: formerAdminRestoreHeaders, body: restoreBytes,
    })).status, 403, "a platform administrator cannot restore an archive they do not own");
    const securedRestoreHeaders = {
      ...ownerHeaders, Cookie: `drevo_session=${guardedOwnerToken}`, "X-Drevo-Restore": "1",
    };
    const guardedPreviewResponse = await fetch(guardedBase + "/api/restore/preview", {
      method: "POST", headers: securedRestoreHeaders, body: restoreBytes,
    });
    assert.equal(guardedPreviewResponse.status, 200, await guardedPreviewResponse.clone().text());
    const guardedPreview = await guardedPreviewResponse.json() as {
      token: string; currentCommentsLost: number; backupCommentsSkipped: number;
    };
    assert.equal(guardedPreview.currentCommentsLost, 1,
      "PostgreSQL preview counts only comments cascaded from this archive");
    assert.equal(guardedPreview.backupCommentsSkipped, 0,
      "the source backup has no comments after its migration fixture is cleared");
    const revisionBeforeRevocation = (await guardedApp.archive.read()).revision;
    const filesBeforeRevocation = readdirSync(guardedUploads).sort();
    const originalRestoreWrite = guardedApp.archive.write;
    let restoreAtCommit!: () => void;
    let resumeRestoreCommit!: () => void;
    const restoreCommitReady = new Promise<void>((resolve) => { restoreAtCommit = resolve; });
    const restoreCommitGate = new Promise<void>((resolve) => { resumeRestoreCommit = resolve; });
    const awaitRestoreBarrier = async (ready: Promise<void>, request: Promise<Response>) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          request.then(async (response) => {
            throw new Error(`Restore completed before the commit barrier: ${response.status} ${await response.clone().text()}`);
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Restore did not reach the commit barrier")), 30_000);
            timeout.unref();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    guardedApp.archive.write = async (...args) => {
      restoreAtCommit();
      await restoreCommitGate;
      return originalRestoreWrite(...args);
    };
    try {
      const pendingApply = fetch(guardedBase + "/api/restore/apply", {
        method: "POST", headers: securedRestoreHeaders,
        body: JSON.stringify({ token: guardedPreview.token, confirm: true }),
      });
      await awaitRestoreBarrier(restoreCommitReady, pendingApply);
      await client.query("DELETE FROM platform_admins WHERE account_id=$1", [guardedOwnerId]);
      resumeRestoreCommit();
      const deniedApply = await pendingApply;
      assert.equal(deniedApply.status, 403, await deniedApply.text());
      assert.equal((await guardedApp.archive.read()).revision, revisionBeforeRevocation);
      assert.deepEqual(readdirSync(guardedUploads).sort(), filesBeforeRevocation,
        "revoked restore removes copies made before the commit check");
      assert.equal((await guardedApp.archive.db.prepare("", "SELECT count(*)::int AS n FROM workflow_stages WHERE kind='restore' AND token=?")
        .get(guardedPreview.token))?.n, 1, "the failed stage stays available for an authorized retry");
    } finally {
      resumeRestoreCommit();
      guardedApp.archive.write = originalRestoreWrite;
      await client.query("INSERT INTO platform_admins(account_id) VALUES($1) ON CONFLICT DO NOTHING", [guardedOwnerId]);
    }
    // A completed ownership transfer before archive.write's final actor check
    // also denies the staged restore without changing bytes or consuming it.
    let transferAtCommit!: () => void;
    let resumeTransferCommit!: () => void;
    const transferCommitReady = new Promise<void>((resolve) => { transferAtCommit = resolve; });
    const transferCommitGate = new Promise<void>((resolve) => { resumeTransferCommit = resolve; });
    guardedApp.archive.write = async (...args) => {
      transferAtCommit();
      await transferCommitGate;
      return originalRestoreWrite(...args);
    };
    try {
      const pendingApply = fetch(guardedBase + "/api/restore/apply", {
        method: "POST", headers: securedRestoreHeaders,
        body: JSON.stringify({ token: guardedPreview.token, confirm: true }),
      });
      await awaitRestoreBarrier(transferCommitReady, pendingApply);
      await client.query("SELECT set_config('drevo.archive_id',$1,false)", [guardedArchiveId]);
      await client.query("UPDATE archive_owners SET user_id=$1 WHERE archive_id=$2 AND user_id=$3",
        [guardedSuccessorId, guardedArchiveId, guardedOwnerId]);
      await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
      resumeTransferCommit();
      const deniedApply = await pendingApply;
      assert.equal(deniedApply.status, 403, await deniedApply.text());
      assert.equal((await guardedApp.archive.read()).revision, revisionBeforeRevocation);
      assert.deepEqual(readdirSync(guardedUploads).sort(), filesBeforeRevocation);
      assert.equal((await guardedApp.archive.db.prepare("", "SELECT count(*)::int AS n FROM workflow_stages WHERE kind='restore' AND token=?")
        .get(guardedPreview.token))?.n, 1);
    } finally {
      resumeTransferCommit();
      guardedApp.archive.write = originalRestoreWrite;
      await client.query("SELECT set_config('drevo.archive_id',$1,false)", [guardedArchiveId]);
      await client.query("UPDATE archive_owners SET user_id=$1 WHERE archive_id=$2 AND user_id=$3",
        [guardedOwnerId, guardedArchiveId, guardedSuccessorId]);
      await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    }
    for (const kind of ["session", "membership"] as const) {
      let reached!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { reached = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      guardedApp.archive.write = async (...args) => {
        reached();
        await gate;
        return originalRestoreWrite(...args);
      };
      try {
        const pending = fetch(guardedBase + "/api/restore/apply", {
          method: "POST", headers: securedRestoreHeaders,
          body: JSON.stringify({ token: guardedPreview.token, confirm: true }),
        });
        await awaitRestoreBarrier(ready, pending);
        if (kind === "session")
          await client.query("DELETE FROM account_sessions WHERE token_hash=$1 AND user_id=$2",
            [sessionTokenHash(guardedOwnerToken), guardedOwnerId]);
        else {
          await client.query("SELECT set_config('drevo.archive_id',$1,false)", [guardedArchiveId]);
          await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id=$1 AND user_id=$2",
            [guardedArchiveId, guardedOwnerId]);
          await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
        }
        release();
        const denied = await pending;
        assert.equal(denied.status, kind === "session" ? 401 : 403, await denied.text());
        assert.equal((await guardedApp.archive.read()).revision, revisionBeforeRevocation);
        assert.deepEqual(readdirSync(guardedUploads).sort(), filesBeforeRevocation,
          "revoked restore leaves no installed original");
        assert.equal((await guardedApp.archive.db.prepare("",
          "SELECT count(*)::int AS n FROM workflow_stages WHERE kind='restore' AND token=?")
          .get(guardedPreview.token))?.n, 1);
      } finally {
        release();
        guardedApp.archive.write = originalRestoreWrite;
        if (kind === "session")
          await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
            VALUES($1,$2,$3) ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at`,
            [sessionTokenHash(guardedOwnerToken), guardedOwnerId, Date.now() + 10 * 60_000]);
        else {
          await client.query("SELECT set_config('drevo.archive_id',$1,false)", [guardedArchiveId]);
          await client.query("UPDATE archive_memberships SET approved=true WHERE archive_id=$1 AND user_id=$2",
            [guardedArchiveId, guardedOwnerId]);
          await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
        }
      }
    }
    // The seed SQLite has no media or documents, so the successful lock test
    // does not copy any original files.
    const noMediaPreviewResponse = await fetch(guardedBase + "/api/restore/preview", {
      method: "POST", headers: securedRestoreHeaders, body: readFileSync(source),
    });
    assert.equal(noMediaPreviewResponse.status, 200, await noMediaPreviewResponse.clone().text());
    const noMediaPreview = await noMediaPreviewResponse.json() as {
      token: string; files: number; documents: number;
    };
    assert.equal(noMediaPreview.files, 0);
    assert.equal(noMediaPreview.documents, 0);
    let platformLockHeld!: () => void;
    let releasePlatformLock!: () => void;
    const platformLockReady = new Promise<void>((resolve) => { platformLockHeld = resolve; });
    const platformLockGate = new Promise<void>((resolve) => { releasePlatformLock = resolve; });
    guardedApp.archive.write = async (...args) => {
      const afterWrite = args[6];
      args[6] = async (db) => {
        await afterWrite?.(db);
        platformLockHeld();
        await platformLockGate;
      };
      return originalRestoreWrite(...args);
    };
    try {
      const pendingApply = fetch(guardedBase + "/api/restore/apply", {
        method: "POST", headers: securedRestoreHeaders,
        body: JSON.stringify({ token: noMediaPreview.token, confirm: true }),
      });
      await awaitRestoreBarrier(platformLockReady, pendingApply);
      const concurrentRevocation = client.query("DELETE FROM platform_admins WHERE account_id=$1", [guardedOwnerId]);
      try {
        assert.equal(await Promise.race([
          concurrentRevocation.then(() => "revoked"),
          new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
        ]), "waiting", "grant revocation waits for an authorized restore commit");
      } finally {
        releasePlatformLock();
      }
      const allowedApply = await pendingApply;
      assert.equal(allowedApply.status, 200, await allowedApply.text());
      await concurrentRevocation;
    } finally {
      releasePlatformLock();
      guardedApp.archive.write = originalRestoreWrite;
      await client.query("INSERT INTO platform_admins(account_id) VALUES($1) ON CONFLICT DO NOTHING", [guardedOwnerId]);
    }
    // Full TAR discussion restore is explicit. The final zero-comment check is
    // made under the same archive lock as all live discussion writers.
    await guardedApp.archive.db.prepare("", "DELETE FROM person_comments").run();
    const discussionSource = await openArchive(":memory:", family);
    const discussionFileId = "8f251989-45a6-4b77-8a47-8f0010001111";
    const discussionOriginal = Buffer.from("PostgreSQL discussion original\n");
    const tarEntry = (name: string, bytes: Buffer) => {
      const header = Buffer.alloc(512);
      header.write(name, 0);
      header.write("0000600\0", 100);
      header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
      header.fill(32, 148, 156);
      header.write("0", 156);
      header.write("ustar\0", 257);
      header.write(header.reduce((sum, byte) => sum + byte, 0)
        .toString(8).padStart(6, "0") + "\0 ", 148);
      return Buffer.concat([header, bytes,
        Buffer.alloc((512 - bytes.length % 512) % 512)]);
    };
    let discussionTar: Buffer;
    try {
      await discussionSource.db.prepare(
        "INSERT INTO person_comments(person_id,author_id,author_name,created_ms,text,attachments) VALUES(?,?,?,?,?,?)",
      ).run("person-a", "owner", "Автор прежнего сайта", 1000,
        "Обсуждение из TAR", JSON.stringify([{
          id: discussionFileId, name: "источник.txt",
          type: "text/plain", size: discussionOriginal.length,
        }]));
      discussionTar = gzipSync(Buffer.concat([
        tarEntry("drevo.sqlite", await databaseBackupBytes(discussionSource.db)),
        tarEntry(`uploads/discussion-files/${discussionFileId}`, discussionOriginal),
        Buffer.alloc(1024),
      ]));
    } finally { await discussionSource.close(); }
    const restoreDiscussionHeaders = {
      ...securedRestoreHeaders, "X-Drevo-Restore-Comments": "1",
    };
    const discussionPreviewResponse = await fetch(guardedBase + "/api/restore/preview", {
      method: "POST", headers: restoreDiscussionHeaders,
      body: Uint8Array.from(discussionTar).buffer,
    });
    assert.equal(discussionPreviewResponse.status, 200,
      await discussionPreviewResponse.clone().text());
    let discussionPreview = await discussionPreviewResponse.json() as {
      token: string; canRestoreComments: boolean; backupCommentsSkipped: number;
    };
    assert.equal(discussionPreview.backupCommentsSkipped, 1);
    assert.equal(discussionPreview.canRestoreComments, true);
    const discussionDirectory = join(guardedUploads, "discussion-files");
    const beforeContested = existsSync(discussionDirectory)
      ? readdirSync(discussionDirectory).sort() : [];
    await guardedApp.archive.db.transaction(async () => {
      await guardedApp.archive.db.prepare("",
        "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,'owner',1001,'Concurrent comment')")
        .run("person-a");
    });
    const contestedApply = await fetch(guardedBase + "/api/restore/apply", {
      method: "POST", headers: securedRestoreHeaders,
      body: JSON.stringify({ token: discussionPreview.token, confirm: true,
        restoreComments: true }),
    });
    assert.equal(contestedApply.status, 409, await contestedApply.clone().text());
    assert.deepEqual(existsSync(discussionDirectory)
      ? readdirSync(discussionDirectory).sort() : [], beforeContested,
    "a comment added after preview blocks restore and cleans the copied original");
    assert.equal((await guardedApp.archive.db.prepare("",
      "SELECT count(*)::int AS count FROM person_comments WHERE text='Concurrent comment'")
      .get())?.count, 1);
    await guardedApp.archive.db.transaction(async () => {
      await guardedApp.archive.db.prepare("",
        "DELETE FROM person_comments WHERE text='Concurrent comment'").run();
    });
    const freshDiscussionPreview = await fetch(guardedBase + "/api/restore/preview", {
      method: "POST", headers: restoreDiscussionHeaders,
      body: Uint8Array.from(discussionTar).buffer,
    });
    assert.equal(freshDiscussionPreview.status, 200,
      await freshDiscussionPreview.clone().text());
    discussionPreview = await freshDiscussionPreview.json();
    assert.equal(discussionPreview.canRestoreComments, true);
    const discussionApply = await fetch(guardedBase + "/api/restore/apply", {
      method: "POST", headers: securedRestoreHeaders,
      body: JSON.stringify({ token: discussionPreview.token, confirm: true,
        restoreComments: true }),
    });
    assert.equal(discussionApply.status, 200, await discussionApply.clone().text());
    const restoredDiscussion = await guardedApp.archive.db.prepare("",
      "SELECT author_id,author_name,text,attachments FROM person_comments WHERE text=?")
      .get("Обсуждение из TAR");
    assert.equal(restoredDiscussion?.author_name, "Автор прежнего сайта");
    assert.notEqual(restoredDiscussion?.author_id, "owner");
    const restoredAttachment = JSON.parse(String(restoredDiscussion?.attachments))[0];
    assert.notEqual(restoredAttachment.id, discussionFileId);
    assert.deepEqual(readFileSync(join(guardedUploads, "discussion-files", restoredAttachment.id)),
      discussionOriginal);
    const repeatPreviewResponse = await fetch(guardedBase + "/api/restore/preview", {
      method: "POST", headers: restoreDiscussionHeaders,
      body: Uint8Array.from(discussionTar).buffer,
    });
    assert.equal(repeatPreviewResponse.status, 200,
      await repeatPreviewResponse.clone().text());
    const repeatPreview = await repeatPreviewResponse.json() as {
      token: string; canRestoreComments: boolean;
    };
    assert.equal(repeatPreview.canRestoreComments, false);
    const repeatedApply = await fetch(guardedBase + "/api/restore/apply", {
      method: "POST", headers: securedRestoreHeaders,
      body: JSON.stringify({ token: repeatPreview.token, confirm: true,
        restoreComments: true }),
    });
    assert.equal(repeatedApply.status, 409);
    assert.equal((await guardedApp.archive.db.prepare("",
      "SELECT count(*)::int AS count FROM person_comments").get())?.count, 1);

    // Exercise the real /a/{id} dispatcher after all guarded-archive fixtures:
    // apply may rebuild its graph, so it must not disturb later root tests.
    const rootBeforeSelected = await rootArchive.read();
    const guardedBeforeSelected = await guardedApp.archive.read();
    const rootStagesBefore = Number((await rootArchive.db.prepare("",
      "SELECT count(*) AS n FROM workflow_stages WHERE kind='restore'").get())?.n);
    const selectedPath = selectedBase + `/a/${guardedArchiveId}`;
    const selectedPreviewResponse = await fetch(selectedPath + "/api/restore/preview", {
      method: "POST", headers: securedRestoreHeaders, body: readFileSync(source),
    });
    assert.equal(selectedPreviewResponse.status, 200, await selectedPreviewResponse.clone().text());
    const selectedPreview = await selectedPreviewResponse.json() as { token: string; revision: number };
    assert.equal(selectedPreview.revision, guardedBeforeSelected.revision);
    assert.equal(Number((await rootArchive.db.prepare("",
      "SELECT count(*) AS n FROM workflow_stages WHERE kind='restore'").get())?.n), rootStagesBefore,
    "selected preview does not stage private data in the root archive");
    assert.equal(Number((await guardedApp.archive.db.prepare("",
      "SELECT count(*) AS n FROM workflow_stages WHERE kind='restore' AND token=?")
      .get(selectedPreview.token))?.n), 1);
    const selectedApplyResponse = await fetch(selectedPath + "/api/restore/apply", {
      method: "POST", headers: securedRestoreHeaders,
      body: JSON.stringify({ token: selectedPreview.token, confirm: true }),
    });
    assert.equal(selectedApplyResponse.status, 200, await selectedApplyResponse.clone().text());
    const selectedApplied = await selectedApplyResponse.json() as { backupName: string };
    assert.equal((await guardedApp.archive.read()).revision, guardedBeforeSelected.revision + 1);
    assert.equal((await rootArchive.read()).revision, rootBeforeSelected.revision,
      "selected apply never writes the root archive");
    assert.equal(Number((await guardedApp.archive.db.prepare("",
      "SELECT count(*) AS n FROM workflow_stages WHERE kind='restore' AND token=?")
      .get(selectedPreview.token))?.n), 0);
    rmSync(join(dirname(guardedApp.archive.db.file), "backups", selectedApplied.backupName), { force: true });
  } finally {
    await started?.close();
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    if (guardedOwnerToken)
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1 AND user_id=$2",
        [sessionTokenHash(guardedOwnerToken), guardedOwnerId]);
    if (grantCreated)
      await client.query("DELETE FROM platform_admins WHERE account_id=$1", [guardedOwnerId]);
  }
}
