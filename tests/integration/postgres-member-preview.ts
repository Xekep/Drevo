import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "pg";
import type { startServer } from "../../src/server/index.ts";
import { archiveQueryHttp } from "../../src/server/archive-query-http.ts";
import { createAuth } from "../../src/server/auth.ts";
import { documentsHttp } from "../../src/server/documents-http.ts";
import { mediaStore } from "../../src/server/media.ts";
import { setMemberPreviewTarget } from "../../src/server/member-preview-access.ts";
import { researchCatalogStore } from "../../src/server/research-catalog.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { settingsStore } from "../../src/server/settings.ts";
import { treePreferencesStore } from "../../src/server/tree-preferences.ts";
import { userStore } from "../../src/server/users.ts";
import { fullName } from "../../src/domain/dates.ts";
import type { Person } from "../../src/domain/types.ts";

/** Real HTTP dispatch must retain the owner's session even for public target reads. */
export async function verifyMemberPreview(
  app: Awaited<ReturnType<typeof startServer>>,
  client: Client,
  base: string,
  uploads: string,
) {
  const archiveId = app.archive.db.archiveId!;
  const targetId = "member-preview-pending";
  const token = newSessionToken();
  const hash = sessionTokenHash(token);
  const headers = { Cookie: `drevo_session=${token}` };
  const prefix = `${base}/preview/${encodeURIComponent(targetId)}`;
  const photoUrl = "/media/member-preview-portrait.png";
  const hiddenPhotoUrl = "/media/member-preview-hidden.png";
  const visibleDocumentId = randomUUID(), hiddenDocumentId = randomUUID();
  const documentBytes = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
  const personId = (await app.archive.read()).family.people[0].id;
  const previousPerson = (await client.query<{ data: unknown }>(
    "SELECT data FROM people WHERE archive_id=$1 AND id=$2", [archiveId, personId],
  )).rows[0]?.data;
  const previousVisibility = (await client.query<{
    public_tree: boolean; public_albums: boolean;
  }>("SELECT public_tree,public_albums FROM archive_access_settings WHERE archive_id=$1",
    [archiveId])).rows[0];
  assert.ok(previousPerson);
  assert.ok(previousVisibility);
  try {
    await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Preview pending',now())",
      [targetId]);
    await client.query(`INSERT INTO archive_memberships
      (archive_id,user_id,role,approved,tree_access)
      VALUES($1,$2,'reader',false,'all')`, [archiveId, targetId]);
    await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES($1,'owner',$2)`, [hash, Date.now() + 60_000]);
    await client.query(`UPDATE archive_access_settings
      SET public_tree=false,public_albums=false WHERE archive_id=$1`, [archiveId]);

    const previewSession = await fetch(`${prefix}/api/session`, { headers });
    assert.equal(previewSession.status, 200);
    const body = await previewSession.json();
    assert.equal(body.user.id, targetId);
    assert.equal(body.user.approved, false);
    assert.equal(body.canEdit, false);
    assert.equal(body.account, null);
    assert.equal(body.participantPreview.id, targetId);
    const selected = await fetch(`${base}/a/${archiveId}/preview/${encodeURIComponent(targetId)}/api/session`,
      { headers });
    assert.equal(selected.status, 200, "the selected archive runtime handles scoped preview");
    assert.equal((await selected.json()).user.id, targetId);
    assert.equal((await fetch(`${base}/a/member-preview-other/preview/${encodeURIComponent(targetId)}/api/session`,
      { headers })).status, 404, "a different archive cannot reuse the selected target");
    assert.equal((await fetch(`${prefix}/api/family?projection=overview`, { headers })).status,
      401, "pending participant has no private-family grant");
    assert.equal((await fetch(`${prefix}/api/session`, { method: "POST", headers })).status, 405);
    assert.equal((await fetch(`${prefix}/api/account/export`, { headers })).status, 404);
    assert.equal((await fetch(`${prefix}/api/tree-preferences`, { headers })).status, 404);

    const portrait = { ...(previousPerson as Record<string, unknown>), photo: photoUrl };
    await client.query("UPDATE people SET data=$1::jsonb WHERE archive_id=$2 AND id=$3",
      [JSON.stringify(portrait), archiveId, personId]);
    await client.query("UPDATE archives SET revision=revision+1 WHERE id=$1", [archiveId]);
    await writeFile(join(uploads, "member-preview-portrait.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/W5kAAAAASUVORK5CYII=", "base64"));
    await client.query(`UPDATE archive_access_settings
      SET public_tree=true,public_albums=false WHERE archive_id=$1`, [archiveId]);
    const publicFamily = await fetch(`${prefix}/api/family?projection=overview`, { headers });
    assert.equal(publicFamily.status, 200);
    const projected = await publicFamily.json();
    assert.equal(projected.user.id, targetId);
    assert.equal(projected.canEdit, false);
    assert.equal(projected.family.people[0].photo, photoUrl);
    assert.equal((await fetch(`${prefix}${photoUrl}`, { headers })).status, 200);

    // Hold an already prepared response before its final delivery transaction.
    // Revocation has committed, so no private or public projection may escape.
    let reached!: () => void;
    let release!: () => void;
    const atDelivery = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const guarded = archiveQueryHttp({
      archive: app.archive,
      auth: await createAuth(await userStore(app.archive.db), app.archive.db,
        "https://member-preview.invalid"),
      visibility: await settingsStore(app.archive.db),
      treePreferences: treePreferencesStore(app.archive.db),
      researchCatalog: researchCatalogStore(app.archive.db),
      beforeDelivery: async () => { reached(); await resume; },
    });
    const server = createServer((req, res) => {
      setMemberPreviewTarget(req, targetId);
      void guarded(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const barrierBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const pending = fetch(`${barrierBase}/api/family?projection=overview`, { headers });
      await Promise.race([atDelivery, new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("preview response did not reach final handoff")), 8_000))]);
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
      release();
      const denied = await pending;
      assert.notEqual(denied.status, 200,
        "completed owner logout before final delivery withholds prepared public family");
      assert.doesNotMatch(await denied.text(), /member-preview-portrait/);
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    for (const path of ["/api/session", "/api/family?projection=overview", photoUrl]) {
      const denied = await fetch(`${prefix}${path}`, { headers });
      assert.notEqual(denied.status, 200,
        `completed owner logout must close preview ${path}, even for public bytes`);
    }
    const newToken = newSessionToken();
    const newHash = sessionTokenHash(newToken);
    await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES($1,'owner',$2)`, [newHash, Date.now() + 60_000]);
    try {
      const approvedHeaders = { Cookie: `drevo_session=${newToken}` };
      const hiddenPerson = { ...(previousPerson as Record<string, unknown>),
        id: "member-preview-hidden-person", name: "Hidden", createdBy: "owner",
        photo: hiddenPhotoUrl, parents: [], spouses: [] };
      const ownPerson = { ...(previousPerson as Record<string, unknown>),
        id: "member-preview-own-person", name: "Own", createdBy: targetId,
        photo: "", parents: [], spouses: [] };
      const partnerPerson = { ...(previousPerson as Record<string, unknown>),
        id: "member-preview-partner-person", name: "Partner", createdBy: "owner",
        photo: "", parents: [], spouses: [] };
      await client.query(`INSERT INTO people(archive_id,id,ordinal,data)
        VALUES($1,$2,(SELECT COALESCE(max(ordinal),0)+1 FROM people WHERE archive_id=$1),$3::jsonb),
              ($1,$4,(SELECT COALESCE(max(ordinal),0)+2 FROM people WHERE archive_id=$1),$5::jsonb)`, [archiveId,
        hiddenPerson.id, JSON.stringify(hiddenPerson), ownPerson.id, JSON.stringify(ownPerson)]);
      await client.query(`INSERT INTO people(archive_id,id,ordinal,data)
        VALUES($1,$2,(SELECT COALESCE(max(ordinal),0)+1 FROM people WHERE archive_id=$1),$3::jsonb)`,
      [archiveId, partnerPerson.id, JSON.stringify(partnerPerson)]);
      await client.query(`INSERT INTO family_unions
        (archive_id,id,participant_a,participant_b,data)
        VALUES($1,'member-preview-hidden-union',$2,$3,$4::jsonb)`, [archiveId,
        ownPerson.id, hiddenPerson.id, JSON.stringify({ id: "member-preview-hidden-union",
          participants: [ownPerson.id, hiddenPerson.id], type: "partnership",
          note: "Private union note", createdBy: "owner" })]);
      await client.query(`INSERT INTO family_unions
        (archive_id,id,participant_a,participant_b,data)
        VALUES($1,'member-preview-partner-union',$2,$3,$4::jsonb)`, [archiveId,
        personId, partnerPerson.id, JSON.stringify({ id: "member-preview-partner-union",
          participants: [personId, partnerPerson.id], type: "civil_union",
          createdBy: "owner" })]);
      await client.query(`UPDATE archive_access_settings
        SET public_tree=false,public_albums=true WHERE archive_id=$1`, [archiveId]);
      const albumsOnly = await fetch(`${prefix}/api/family`, { headers: approvedHeaders });
      assert.equal(albumsOnly.status, 200);
      const albumFamily = (await albumsOnly.json()).family;
      assert.deepEqual(albumFamily.people, []);
      assert.deepEqual(albumFamily.links, []);
      assert.deepEqual(albumFamily.unions, [], "public albums never disclose private unions");
      await client.query(`UPDATE archive_access_settings
        SET public_tree=true,public_albums=false WHERE archive_id=$1`, [archiveId]);
      await client.query(`UPDATE archive_memberships SET approved=true,
        tree_access='common_ancestors',person_id=$3 WHERE archive_id=$1 AND user_id=$2`,
      [archiveId, targetId, personId]);
      await client.query("UPDATE archives SET revision=revision+1 WHERE id=$1", [archiveId]);
      await writeFile(join(uploads, "member-preview-hidden.png"),
        Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/W5kAAAAASUVORK5CYII=", "base64"));
      for (const [id, title, linkedPersonId] of [
        [visibleDocumentId, "Visible preview document", personId],
        [hiddenDocumentId, "Hidden owner document", hiddenPerson.id],
      ]) {
        await writeFile(join(uploads, `${id}.pdf`), documentBytes);
        await client.query(`INSERT INTO documents(archive_id,id,ordinal,title,title_search,
          file_name,file_size,uploaded_by,created_at,annotations)
          VALUES($1,$2,(SELECT COALESCE(max(ordinal),0)+1 FROM documents WHERE archive_id=$1),
            $3,lower($3),$4,$5,'owner',now(),$6::jsonb)`, [archiveId,id,title,
          `${id}.pdf`,documentBytes.length,JSON.stringify([{
            id: randomUUID(), authorId: targetId, text: "Synthetic note",
          }])]);
        await client.query(`INSERT INTO document_people(archive_id,ordinal,document_id,person_id)
          VALUES($1,(SELECT COALESCE(max(ordinal),0)+1 FROM document_people WHERE archive_id=$1),
            $2,$3)`, [archiveId,id,linkedPersonId]);
      }
      const scopedFamilyResponse = await fetch(`${prefix}/api/family`,
        { headers: approvedHeaders });
      assert.equal(scopedFamilyResponse.status, 200);
      const scopedFamily = await scopedFamilyResponse.json();
      const scopedIds = scopedFamily.family.people.map((person: { id: string }) => person.id);
      assert.ok(scopedIds.includes(personId));
      assert.ok(scopedIds.includes(ownPerson.id), "target-authored branch stays visible");
      assert.ok(scopedIds.includes(partnerPerson.id), "recorded blood-relative partner stays visible without spouses duplication");
      assert.ok(!scopedIds.includes(hiddenPerson.id), "owner-only branch stays hidden");
      assert.equal((await fetch(`${prefix}${hiddenPhotoUrl}`,
        { headers: approvedHeaders })).status, 401);
      assert.equal((await fetch(`${prefix}/api/people/${personId}/discussion`,
        { headers: approvedHeaders })).status, 200);
      assert.equal((await fetch(`${prefix}/api/people/${hiddenPerson.id}/discussion`,
        { headers: approvedHeaders })).status, 404);
      const documentList = await fetch(`${prefix}/api/documents`,
        { headers: approvedHeaders });
      assert.equal(documentList.status, 200);
      const documentItems = (await documentList.json()).items as Array<{ id: string }>;
      assert.ok(documentItems.some((item) => item.id === visibleDocumentId));
      assert.ok(!documentItems.some((item) => item.id === hiddenDocumentId));
      const visibleFile = await fetch(`${prefix}/api/documents/${visibleDocumentId}/file`,
        { headers: approvedHeaders });
      assert.equal(visibleFile.status, 200);
      assert.deepEqual(Buffer.from(await visibleFile.arrayBuffer()), documentBytes);
      const annotationUrl = `/api/documents/${visibleDocumentId}/annotations`;
      const annotations = await fetch(`${prefix}${annotationUrl}`,
        { headers: approvedHeaders });
      assert.equal(annotations.status, 200);
      const annotationItems = (await annotations.json()).items;
      assert.equal(annotationItems[0].authorName, fullName(portrait as Person),
        "document comments use the author's archive-linked full name in participant preview");
      assert.deepEqual(annotationItems.map((item: {
        canEdit: boolean; canDelete: boolean;
      }) => [item.canEdit, item.canDelete]), [[false, false]]);
      for (const suffix of ["", "/file", "/annotations"])
        assert.equal((await fetch(`${prefix}/api/documents/${hiddenDocumentId}${suffix}`,
          { headers: approvedHeaders })).status, 404);

      let annotationsReached!: () => void;
      let annotationsResume!: () => void;
      const atAnnotations = new Promise<void>((resolve) => { annotationsReached = resolve; });
      const resumeAnnotations = new Promise<void>((resolve) => { annotationsResume = resolve; });
      const annotationAuth = await createAuth(await userStore(app.archive.db),
        app.archive.db, "https://member-preview.invalid");
      const directDocuments = documentsHttp({ archive: app.archive, auth: annotationAuth,
        media: mediaStore(uploads), uploadsDirectory: uploads,
        beforeMetadataDelivery: async () => {
          annotationsReached();
          await resumeAnnotations;
        } });
      const annotationServer = createServer((req, res) => {
        setMemberPreviewTarget(req, targetId);
        void directDocuments(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
          .catch((error) => res.destroy(error));
      });
      await new Promise<void>((resolve) => annotationServer.listen(0, "127.0.0.1", resolve));
      try {
        const annotationBase = `http://127.0.0.1:${(annotationServer.address() as { port: number }).port}`;
        const pendingAnnotation = fetch(annotationBase + annotationUrl,
          { headers: approvedHeaders });
        await Promise.race([atAnnotations, new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("annotation response did not prepare")), 8_000))]);
        await client.query(`UPDATE archive_memberships SET person_id=$3
          WHERE archive_id=$1 AND user_id=$2`, [archiveId,targetId,hiddenPerson.id]);
        annotationsResume();
        assert.notEqual((await pendingAnnotation).status, 200,
          "target scope change before annotation delivery withholds old projection");
      } finally {
        annotationsResume();
        annotationServer.closeAllConnections();
        await new Promise<void>((resolve) => annotationServer.close(() => resolve()));
      }
      await client.query(`UPDATE archive_memberships SET person_id=$3
        WHERE archive_id=$1 AND user_id=$2`, [archiveId,targetId,personId]);
      const expiresToken = newSessionToken();
      const expiresHash = sessionTokenHash(expiresToken);
      let expiresAt = Date.now() + 60_000;
      await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
        VALUES($1,'owner',$2)`, [expiresHash, expiresAt]);
      let expiryReached!: () => void;
      const atExpiryLock = new Promise<void>((resolve) => { expiryReached = resolve; });
      const expiryRoute = archiveQueryHttp({ archive: app.archive,
        auth: await createAuth(await userStore(app.archive.db), app.archive.db,
          "https://member-preview.invalid"),
        visibility: await settingsStore(app.archive.db),
        treePreferences: treePreferencesStore(app.archive.db),
        researchCatalog: researchCatalogStore(app.archive.db),
        beforeLockedDelivery: async () => {
          expiryReached();
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 25)));
        },
      });
      const expiryServer = createServer((req, res) => {
        setMemberPreviewTarget(req, targetId);
        void expiryRoute(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
          .catch((error) => res.destroy(error));
      });
      await new Promise<void>((resolve) => expiryServer.listen(0, "127.0.0.1", resolve));
      try {
        expiresAt = Date.now() + 5_000;
        await client.query(`UPDATE account_sessions SET expires_at=$2 WHERE token_hash=$1`,
          [expiresHash, expiresAt]);
        const expiryBase = `http://127.0.0.1:${(expiryServer.address() as { port: number }).port}`;
        const pendingExpired = fetch(`${expiryBase}/api/family?projection=overview`,
          { headers: { Cookie: `drevo_session=${expiresToken}` } });
        await Promise.race([atExpiryLock, new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("expiring preview did not reach locked handoff")), 8_000))]);
        assert.notEqual((await pendingExpired).status, 200,
          "locked owner session expiry before first byte denies prepared preview");
      } finally {
        expiryServer.closeAllConnections();
        await new Promise<void>((resolve) => expiryServer.close(() => resolve()));
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [expiresHash]);
      }
      await client.query("DELETE FROM archive_memberships WHERE archive_id=$1 AND user_id=$2",
        [archiveId, targetId]);
      assert.equal((await fetch(`${prefix}/api/session`, {
        headers: { Cookie: `drevo_session=${newToken}` },
      })).status, 403, "removed target membership cannot be previewed");
    } finally {
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [newHash]);
    }
    console.log("runtime_member_preview_owner_target_public_gate_ok");
  } finally {
    await client.query("DELETE FROM documents WHERE archive_id=$1 AND id=ANY($2::text[])",
      [archiveId, [visibleDocumentId, hiddenDocumentId]]);
    await client.query("DELETE FROM family_unions WHERE archive_id=$1 AND id=ANY($2::text[])",
      [archiveId, ["member-preview-hidden-union", "member-preview-partner-union"]]);
    await client.query("DELETE FROM people WHERE archive_id=$1 AND id=ANY($2::text[])",
      [archiveId, ["member-preview-hidden-person", "member-preview-own-person", "member-preview-partner-person"]]);
    for (const name of [`${visibleDocumentId}.pdf`, `${hiddenDocumentId}.pdf`,
      "member-preview-hidden.png", "member-preview-portrait.png"])
      await unlink(join(uploads, name)).catch(() => {});
    await client.query("UPDATE people SET data=$1::jsonb WHERE archive_id=$2 AND id=$3",
      [JSON.stringify(previousPerson), archiveId, personId]);
    await client.query("UPDATE archives SET revision=revision+1 WHERE id=$1", [archiveId]);
    await client.query(`UPDATE archive_access_settings SET public_tree=$2,public_albums=$3
      WHERE archive_id=$1`, [archiveId, previousVisibility.public_tree, previousVisibility.public_albums]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
    await client.query("DELETE FROM accounts WHERE id=$1", [targetId]);
  }
}
