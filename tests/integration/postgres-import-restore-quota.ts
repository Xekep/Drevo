import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type pg from "pg";
import sharp from "sharp";
import type { Family } from "../../src/domain/types.ts";
import { familyMedia } from "../../src/domain/genealogy-transfer.ts";
import { openArchive } from "../../src/server/database.ts";
import { writeGenealogyPackage } from "../../src/server/genealogy-package.ts";
import { startServer } from "../../src/server/index.ts";
import { BASIC_MEDIA_BYTES, postgresMediaBytes } from "../../src/server/postgres-media-quota.ts";
import { writePortablePackage } from "../../src/server/portable-package.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { databaseBackupBytes } from "../helpers/database-backup.ts";

const archiveId = "import-restore-quota-r3";
const accountId = "import-restore-quota-owner";
const imageName = "2aeb3730-316f-4e04-810b-bc0c905e4358.png";

function person(id: string, index: number, actor?: string): Family["people"][number] {
  return {
    id, name: `Quota ${index}`, surname: "Fixture", patronymic: "", sex: "u",
    birth: "", birthPlace: "", parents: [], spouses: [], sources: [],
    generation: 1, column: index, ...(actor ? { createdBy: actor } : {}),
  };
}

function familyWithPeople(count: number): Family {
  return {
    title: "Quota fixture", description: "", demo: false, photos: [], links: [],
    people: [person("quota-root", 0, accountId),
      ...Array.from({ length: count - 1 }, (_, index) =>
        person(`quota-restored-${index}`, index + 1, accountId))],
  };
}

function gedcom(count: number) {
  return ["0 HEAD", "1 SOUR DREVO-TEST", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    ...Array.from({ length: count }, (_, index) =>
      `0 @I${index + 1}@ INDI\n1 NAME Import${index + 1} /Quota/\n1 SEX U`),
    "0 TRLR", ""].join("\n");
}

function tarEntry(name: string, bytes: Buffer) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000600\0", 100);
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write(header.reduce((sum, byte) => sum + byte, 0)
    .toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

async function backupBytes(family: Family, image?: Buffer) {
  // :memory: forces the SQLite backup source even while the HTTP target uses
  // DATABASE_BACKEND=postgres. A named file would reopen the target archive.
  const archive = await openArchive(":memory:", family);
  try {
    const sqlite = await databaseBackupBytes(archive.db);
    return image ? gzipSync(Buffer.concat([
      tarEntry("drevo.sqlite", sqlite), tarEntry(`uploads/${imageName}`, image), Buffer.alloc(1024),
    ])) : sqlite;
  } finally { await archive.close(); }
}

export async function verifyImportRestoreQuota({ client, source }: {
  client: pg.Client;
  source: string;
}) {
  const directory = dirname(source);
  const token = newSessionToken();
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  const primaryBefore = (await client.query(`SELECT revision,
    (SELECT count(*)::int FROM people WHERE archive_id='runtime-test') AS people
    FROM archives WHERE id='runtime-test'`)).rows[0];
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  let created = false;
  try {
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
    await client.query(`INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version)
      VALUES($1,'Quota import/restore','',false,0,18)`, [archiveId]);
    created = true;
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Quota owner',$2)",
      [accountId, new Date().toISOString()]);
    await client.query("INSERT INTO account_tiers(account_id,full_access) VALUES($1,false)", [accountId]);
    await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
      VALUES($1,$2,'relative',true,'all')`, [archiveId, accountId]);
    await client.query("INSERT INTO archive_owners(archive_id,user_id) VALUES($1,$2)",
      [archiveId, accountId]);
    await client.query("INSERT INTO platform_admins(account_id) VALUES($1)", [accountId]);
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [sessionTokenHash(token), accountId, Date.now() + 30 * 60_000]);
    await client.query("INSERT INTO people(id,data) VALUES($1,$2)",
      ["quota-root", JSON.stringify(person("quota-root", 0, accountId))]);
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");

    app = await startServer(0, source, true, undefined, undefined, archiveId);
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const headers = { Cookie: `drevo_session=${token}`, Origin: process.env.PUBLIC_ORIGIN!,
      "X-Drevo-Import": "1" };
    const restoreHeaders = { ...headers, "X-Drevo-Restore": "1" };
    const db = app.archive.db;
    const uploads = join(dirname(db.file), "uploads");
    mkdirSync(uploads, { recursive: true });
    const snapshot = async () => ({
      value: await app!.archive.read(),
      history: Number((await db.prepare("", "SELECT count(*) AS n FROM history").get())?.n),
      originals: Number((await db.prepare("", "SELECT count(*) AS n FROM media_originals").get())?.n),
      documents: Number((await db.prepare("", "SELECT count(*) AS n FROM documents").get())?.n),
      reservations: Number((await db.prepare("", "SELECT count(*) AS n FROM platform_upload_reservations").get())?.n),
      files: readdirSync(uploads).sort(),
    });
    const previewGedcom = async (bytes: Buffer) => {
      const response = await fetch(`${base}/api/gedcom/preview`, {
        method: "POST", headers, body: new Uint8Array(bytes),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json() as { token: string }).token;
    };
    const applyGedcom = (stage: string) => fetch(`${base}/api/gedcom/import`, {
      method: "POST", headers, body: JSON.stringify({ token: stage, confirm: true }),
    });
    const previewRestore = async (bytes: Buffer) => {
      const response = await fetch(`${base}/api/restore/preview`, {
        method: "POST", headers: restoreHeaders, body: new Uint8Array(bytes),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json() as { token: string }).token;
    };
    const applyRestore = (stage: string) => fetch(`${base}/api/restore/apply`, {
      method: "POST", headers: restoreHeaders,
      body: JSON.stringify({ token: stage, confirm: true }),
    });

    // The existing archive.write tests cover 150/151. This exercises the
    // persisted GEDCOM stage and the final HTTP transaction, not just preview.
    const beforePeople = await snapshot();
    const tooMany = await applyGedcom(await previewGedcom(Buffer.from(gedcom(150))));
    assert.equal(tooMany.status, 403, await tooMany.text());
    assert.deepEqual(await snapshot(), beforePeople,
      "denied GEDCOM import must not change the family, revision, history or media");
    const atPeopleLimit = await applyGedcom(await previewGedcom(Buffer.from(gedcom(149))));
    assert.equal(atPeopleLimit.status, 200, await atPeopleLimit.text());
    assert.equal((await app.archive.read()).family.people.length, 150);
    const current = await app.archive.read();
    await app.archive.write(familyWithPeople(1), current.revision);

    const restored151 = await backupBytes(familyWithPeople(151));
    const restored150 = await backupBytes(familyWithPeople(150));
    const beforeRestorePeople = await snapshot();
    const rejectedRestore = await applyRestore(await previewRestore(restored151));
    assert.equal(rejectedRestore.status, 403, await rejectedRestore.text());
    assert.deepEqual(await snapshot(), beforeRestorePeople,
      "denied restore must roll back family, revision, history, files and reservations");
    const acceptedRestore = await applyRestore(await previewRestore(restored150));
    assert.equal(acceptedRestore.status, 200, await acceptedRestore.text());
    assert.equal((await app.archive.read()).family.people.length, 150);

    // An already oversized tree can still be reduced after a tier downgrade.
    await db.prepare("", "UPDATE account_tiers SET full_access=true WHERE account_id=?").run(accountId);
    const fullRestore = await applyRestore(await previewRestore(restored151));
    assert.equal(fullRestore.status, 200, await fullRestore.text());
    await db.prepare("", "UPDATE account_tiers SET full_access=false WHERE account_id=?").run(accountId);
    const nonGrowing = await applyRestore(await previewRestore(restored151));
    assert.equal(nonGrowing.status, 200, await nonGrowing.text());
    const shrink = await applyRestore(await previewRestore(restored150));
    assert.equal(shrink.status, 200, await shrink.text());

    // Synthetic attachment metadata reserves the near-limit baseline without
    // allocating a 500 MB file. The imported original itself is genuine PNG.
    const beforeMediaFamily = await app.archive.read();
    await app.archive.write(familyWithPeople(1), beforeMediaFamily.revision);
    const png = await sharp({ create: { width: 2, height: 2, channels: 4,
      background: "#457ab3" } }).png().toBuffer();
    const attachmentId = randomUUID();
    const setAttachmentSize = (size: number) => db.prepare("",
      "UPDATE person_comments SET attachments=? WHERE person_id='quota-root'")
      .run(JSON.stringify([{ id: attachmentId, name: "quota.bin",
        type: "application/octet-stream", size }]));
    await db.prepare("", `INSERT INTO person_comments(person_id,author_id,created_ms,text,attachments)
      VALUES('quota-root',?,1000,'Quota metadata','[]')`).run(accountId);

    const sourceUploads = join(directory, "quota-source-uploads");
    mkdirSync(sourceUploads, { recursive: true });
    writeFileSync(join(sourceUploads, imageName), png);
    const mediaFamily: Family = {
      ...familyWithPeople(1), people: [person("quota-media-person", 1, accountId)],
      photos: [{ id: "quota-media-photo", url: `/media/${imageName}`, title: "Quota image",
        tags: [{ id: "quota-media-tag", personId: "quota-media-person",
          x: 0, y: 0, width: 1, height: 1 }] }],
    };
    const packagePath = join(directory, "quota-import.gdz");
    await writeGenealogyPackage(packagePath, sourceUploads, mediaFamily,
      familyMedia(mediaFamily));
    await setAttachmentSize(BASIC_MEDIA_BYTES - png.length + 1);
    const beforeGedzip = await snapshot();
    const overBytes = await applyGedcom(await previewGedcom(readFileSync(packagePath)));
    assert.equal(overBytes.status, 507, await overBytes.text());
    assert.deepEqual(await snapshot(), beforeGedzip,
      "denied GEDZIP import must remove copied originals and roll back quota/history");
    await setAttachmentSize(BASIC_MEDIA_BYTES - png.length);
    const exactBytes = await applyGedcom(await previewGedcom(readFileSync(packagePath)));
    assert.equal(exactBytes.status, 200, await exactBytes.text());
    assert.equal((await app.archive.read()).family.photos?.length, 1);
    assert.equal(await postgresMediaBytes(db), BASIC_MEDIA_BYTES);

    // A native TAR restore replaces its own staged original. Retained current
    // comment metadata supplies the independent near-limit byte baseline.
    const beforeRestoreMedia = await app.archive.read();
    await app.archive.write(familyWithPeople(1), beforeRestoreMedia.revision);
    const restoreMediaFamily: Family = { ...familyWithPeople(1), photos: [{
      id: "quota-restored-photo", url: `/media/${imageName}`, title: "Restored image",
      tags: [{ id: "quota-restored-tag", personId: "quota-root",
        x: 0, y: 0, width: 1, height: 1 }],
    }] };
    const restoreTar = await backupBytes(restoreMediaFamily, png);
    await setAttachmentSize(BASIC_MEDIA_BYTES - png.length + 1);
    const beforeMediaRestore = await snapshot();
    const rejectedMediaRestore = await applyRestore(await previewRestore(restoreTar));
    assert.equal(rejectedMediaRestore.status, 507, await rejectedMediaRestore.text());
    assert.deepEqual(await snapshot(), beforeMediaRestore,
      "denied restore must remove remapped original and roll back quota/history");
    await setAttachmentSize(BASIC_MEDIA_BYTES - png.length);
    const acceptedMediaRestore = await applyRestore(await previewRestore(restoreTar));
    assert.equal(acceptedMediaRestore.status, 200, await acceptedMediaRestore.text());
    assert.equal((await app.archive.read()).family.photos?.length, 1);
    assert.equal(await postgresMediaBytes(db), BASIC_MEDIA_BYTES);

    // The restored picture remains counted after a full-to-basic downgrade.
    // Replacing it with the same bytes does not increase storage usage.
    await db.prepare("", "UPDATE account_tiers SET full_access=true WHERE account_id=?").run(accountId);
    await setAttachmentSize(BASIC_MEDIA_BYTES - png.length + 1);
    assert.equal(await postgresMediaBytes(db), BASIC_MEDIA_BYTES + 1);
    await db.prepare("", "UPDATE account_tiers SET full_access=false WHERE account_id=?").run(accountId);
    const retainedOverLimit = await snapshot();
    const nonGrowingMediaRestore = await applyRestore(await previewRestore(restoreTar));
    if (nonGrowingMediaRestore.status !== 200)
      assert.deepEqual(await snapshot(), retainedOverLimit,
        "a rejected non-growing restore must still roll back files and revision");
    assert.equal(nonGrowingMediaRestore.status, 200, await nonGrowingMediaRestore.text());
    assert.equal(await postgresMediaBytes(db), BASIC_MEDIA_BYTES + 1);
    assert.equal((await app.archive.read()).family.people.length, 1);
    assert.equal(retainedOverLimit.value.family.people.length, 1);

    // A portable package with no media does not increase an already oversized
    // archive. Preview and the final writer must agree after a tier downgrade.
    await db.prepare("", "DELETE FROM person_comments WHERE person_id='quota-root'").run();
    const beforePortableEmpty = await app.archive.read();
    await app.archive.write({ title: "Empty portable target", description: "", demo: false,
      people: [], photos: [], links: [] }, beforePortableEmpty.revision);
    const heldUrl = `/media/${randomUUID()}.png`;
    await db.prepare("", "INSERT INTO media_originals(url,size_bytes) VALUES(?,?)")
      .run(heldUrl, BASIC_MEDIA_BYTES + 1);
    await db.prepare("", "INSERT INTO media_upload_grants(url,user_id,expires_ms) VALUES(?,?,?)")
      .run(heldUrl, accountId, Date.now() + 60 * 60_000);
    assert.equal(await postgresMediaBytes(db), BASIC_MEDIA_BYTES + 1);
    const portablePath = join(directory, "quota-no-media.drevo");
    await writePortablePackage(createWriteStream(portablePath), directory, {
      family: familyWithPeople(1), documents: [], comments: [], sources: [],
    }, async () => {});
    const portablePreview = await fetch(`${base}/api/drevo/preview`, {
      method: "POST", headers, body: readFileSync(portablePath),
    });
    assert.equal(portablePreview.status, 200, await portablePreview.clone().text());
    const portableStage = await portablePreview.json() as { token: string; canImport: boolean };
    assert.equal(portableStage.canImport, true,
      "a metadata-only portable import must not be blocked by existing over-limit media");
    const portableApply = await fetch(`${base}/api/drevo/import`, {
      method: "POST", headers,
      body: JSON.stringify({ token: portableStage.token, confirm: true }),
    });
    assert.equal(portableApply.status, 200, await portableApply.text());
    assert.equal((await app.archive.read()).family.people.length, 1);
    assert.equal(await postgresMediaBytes(db), BASIC_MEDIA_BYTES + 1);
    assert.deepEqual((await client.query(`SELECT revision,
      (SELECT count(*)::int FROM people WHERE archive_id='runtime-test') AS people
      FROM archives WHERE id='runtime-test'`)).rows[0], primaryBefore,
    "quota fixtures in a second archive must not change the primary archive");
    console.log("runtime_import_restore_quota_ok");
  } finally {
    await app?.close();
    if (created) {
      await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
      await client.query("DELETE FROM archive_owners WHERE archive_id=$1", [archiveId]);
      await client.query("DELETE FROM archives WHERE id=$1", [archiveId]);
      await client.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    }
  }
}
