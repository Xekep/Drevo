import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type pg from "pg";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { discoveryMatchesHttp } from "../../src/server/discovery-matches-http.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

const acceptedNote = "После сравнения опубликованных полей";
const rejectedNote = "Опубликованные сведения расходятся";

async function savedNote(db: StoreDatabase, matchId: string) {
  return (await db.prepare("", `SELECT note FROM discovery_match_decision_notes
    WHERE match_id=?`).get(matchId))?.note;
}

export async function acceptWithDecisionNote({ db, matchId, matchPath, reviewToken,
  requestReviewToken,
  otherBase, securedBase, recipientHeaders, senderHeaders, publicHeaders }: {
  db: StoreDatabase; matchId: string; matchPath: string; reviewToken: string;
  requestReviewToken: string;
  otherBase: string; securedBase: string; recipientHeaders: HeadersInit;
  senderHeaders: HeadersInit; publicHeaders: HeadersInit;
}) {
  assert.equal(await savedNote(db,matchId), undefined,
    "a stale review and a sender's forbidden decision cannot leave an explanation");
  assert.equal((await fetch(otherBase + matchPath, {
    method: "PATCH", headers: recipientHeaders,
    body: JSON.stringify({ decision: "accept", reviewToken, note: "x".repeat(501) }),
  })).status, 400, "decision explanations are capped before any write");
  const acceptedMatch = await fetch(otherBase + matchPath, {
    method: "PATCH", headers: recipientHeaders,
    body: JSON.stringify({ decision: "accept", reviewToken, note: `  ${acceptedNote}  ` }),
  });
  assert.equal(acceptedMatch.status, 200);
  assert.equal((await acceptedMatch.json()).match.status, "linked");
  const audit = await db.prepare("", `SELECT requested_by,request_review_token,
    responded_by,responded_at,decision_review_token,decision_txid
    FROM discovery_match_requests WHERE id=?`).get(matchId);
  assert.equal(audit?.requested_by, "owner");
  assert.equal(audit?.request_review_token, requestReviewToken);
  assert.equal(audit?.responded_by, "vk:42");
  assert.ok(audit?.responded_at);
  assert.equal(audit?.decision_review_token, reviewToken);
  await verifyAcceptedDecisionNote({ db, matchId, decisionTxid: audit?.decision_txid,
    matchPath, reviewToken, otherBase, securedBase, recipientHeaders, senderHeaders,
    publicHeaders });
  console.log("runtime_discovery_match_decision_note_accept_ok");
  return audit;
}

export async function verifyAcceptedDecisionNote({ db, matchId, decisionTxid,
  matchPath, reviewToken, otherBase, securedBase, recipientHeaders, senderHeaders,
  publicHeaders }: {
  db: StoreDatabase; matchId: string; decisionTxid: unknown; matchPath: string;
  reviewToken: string; otherBase: string; securedBase: string;
  recipientHeaders: HeadersInit; senderHeaders: HeadersInit; publicHeaders: HeadersInit;
}) {
  assert.ok(decisionTxid, "the decision records the transaction authorized to save its note");
  assert.equal(await savedNote(db, matchId), acceptedNote,
    "only the successful reviewed decision saves a trimmed explanation");
  await assert.rejects(db.prepare("", `UPDATE discovery_match_requests
    SET decision_txid=txid_current() WHERE id=?`).run(matchId),
  (error: unknown) => (error as { code?: string }).code === "42501",
  "a participant cannot refresh the decision transaction to append a later note");
  assert.equal((await fetch(otherBase + matchPath, {
    method: "PATCH", headers: recipientHeaders,
    body: JSON.stringify({ decision: "accept", reviewToken,
      note: "Попытка заменить пояснение" }),
  })).status, 200, "an idempotent accept cannot replace its note");
  assert.equal(await savedNote(db, matchId), acceptedNote);
  assert.equal((await db.prepare("", `UPDATE discovery_match_decision_notes
    SET note='replacement' WHERE match_id=?`).run(matchId)).changes, 0,
  "a participant cannot overwrite the explanation through SQL");
  assert.equal((await db.prepare("", `DELETE FROM discovery_match_decision_notes
    WHERE match_id=?`).run(matchId)).changes, 0,
  "a participant cannot erase the explanation through SQL");
  await db.transaction(async () => {
    await db.prepare("", "SELECT set_config('drevo.archive_id',?,true)").get("unrelated-archive");
    assert.equal((await db.prepare("", `SELECT count(*)::int AS n
      FROM discovery_match_decision_notes WHERE match_id=?`).get(matchId))?.n, 0,
    "a third archive cannot read the explanation through RLS");
  }, true);
  const recipientList = await fetch(otherBase + "/api/discovery/matches", { headers: recipientHeaders });
  assert.equal(recipientList.status, 200);
  assert.equal((await recipientList.json()).matches.find((item: { id: string }) =>
    item.id === matchId)?.decisionNote, acceptedNote);
  const senderList = await fetch(securedBase + "/api/discovery/matches", { headers: senderHeaders });
  assert.equal(senderList.status, 200);
  assert.equal((await senderList.json()).matches.find((item: { id: string }) =>
    item.id === matchId)?.decisionNote, acceptedNote,
  "both participating owners see the original explanation");
  assert.doesNotMatch(JSON.stringify(await (await fetch(securedBase +
    "/api/discovery/people/other-archive/person-a", { headers: publicHeaders })).json()),
    /После сравнения опубликованных полей/,
  "the public linked-card projection never contains the private explanation");
}

export async function verifyRejectedDecisionNote(db: StoreDatabase, matchId: string,
  otherBase: string, recipientHeaders: HeadersInit) {
  assert.equal(await savedNote(db, matchId), rejectedNote,
    "the recipient may explain a rejection without publishing card fields");
  const list = await fetch(otherBase + "/api/discovery/matches", { headers: recipientHeaders });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).matches.find((item: { id: string }) =>
    item.id === matchId)?.decisionNote, rejectedNote);
}

export async function rejectWithStableDecisionNote({ archive, client, matchId, recipientHeaders }: {
  archive: Awaited<ReturnType<typeof openArchive>>; client: pg.Client;
  matchId: string; recipientHeaders: HeadersInit;
}) {
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  const originalVersion = (await client.query<{ publication_version: string }>(`
    SELECT publication_version FROM discovery_people
    WHERE archive_id='runtime-test' AND person_id='person-a'`)).rows[0].publication_version;
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const auth = await createAuth(await userStore(archive.db), archive.db, process.env.PUBLIC_ORIGIN);
  const endpoint = discoveryMatchesHttp({ archive, auth, publicOrigin: process.env.PUBLIC_ORIGIN,
    beforeDecisionNoteInsert: async () => { reached(); await gate; },
  });
  const server = createServer((req,res) => {
    void endpoint(req,res,new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => { res.destroy(error); });
  });
  await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
  const port = (server.address() as { port: number }).port;
  const headers = new Headers(recipientHeaders);
  headers.set("X-Real-IP","198.51.100.111");
  const request = fetch(`http://127.0.0.1:${port}/api/discovery/matches/${matchId}`, {
    method: "PATCH", headers,
    body: JSON.stringify({ decision: "reject", note: rejectedNote }),
  });
  let mutation: Promise<void> | undefined;
  let mutationSettled = false;
  let mutationError: unknown;
  try {
    await Promise.race([ready,
      request.then((response) => { throw new Error(`reject finished before barrier: ${response.status}`); }),
      new Promise<never>((_,reject) => setTimeout(() =>
        reject(new Error("reject did not reach decision-note barrier")),30_000)),
    ]);
    mutation = client.query(`UPDATE discovery_people SET publication_version=$1
      WHERE archive_id='runtime-test' AND person_id='person-a'`, [randomUUID()])
      .then(() => { mutationSettled = true; },(error: unknown) => {
        mutationSettled = true; mutationError = error;
      });
    await new Promise((resolve) => setTimeout(resolve,200));
    assert.equal(mutationSettled,false,
      "a concurrent publication edit must wait until the reject and its note commit");
    release();
    const response = await request;
    assert.ok(response.status === 200 || response.status === 409,
      `a post-commit publication edit may invalidate final delivery, but not the decision: ${response.status} ${await response.text()}`);
    await mutation;
    if (mutationError) throw mutationError;
    const decided = (await client.query<{ status: string; decision_txid: string | null }>(`
      SELECT status,decision_txid FROM discovery_match_requests WHERE id=$1`,[matchId])).rows[0];
    assert.equal(decided.status,"rejected");
    assert.ok(decided.decision_txid,
      "the concurrent edit cannot force a rollback of the reviewed decision or note");
    console.log("runtime_discovery_match_decision_note_publication_lock_ok");
  } finally {
    release();
    await request.catch(() => undefined);
    if (mutation) await mutation;
    await client.query(`UPDATE discovery_people SET publication_version=$1
      WHERE archive_id='runtime-test' AND person_id='person-a'`,[originalVersion]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function verifyRejectedNoteUnchanged(db: StoreDatabase, matchId: string) {
  assert.equal(await savedNote(db, matchId), rejectedNote,
    "repeating a rejection cannot replace the original explanation");
}

export async function verifyNoteHiddenAfterPublicationChange(db: StoreDatabase, matchId: string,
  otherBase: string, recipientHeaders: HeadersInit) {
  assert.equal((await db.prepare("", `SELECT count(*)::int AS n
    FROM discovery_match_decision_notes WHERE match_id=?`).get(matchId))?.n, 0,
  "a changed publication version hides the old free text through RLS");
  const list = await fetch(otherBase + "/api/discovery/matches", { headers: recipientHeaders });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).matches.find((item: { id: string }) =>
    item.id === matchId)?.decisionNote, undefined,
  "withdrawing a formerly published field hides the old free text over HTTP");
  console.log("runtime_discovery_match_decision_note_field_withdrawal_ok");
}

export async function verifyLateNoteDenied(client: pg.Client, matchId: string) {
  const insert = `INSERT INTO discovery_match_decision_notes(
      match_id,note,left_publication_version,right_publication_version)
    SELECT m.id,$2,l.publication_version,r.publication_version
    FROM discovery_match_requests m
    JOIN discovery_people l ON l.archive_id=m.left_archive_id AND l.person_id=m.left_person_id
    JOIN discovery_people r ON r.archive_id=m.right_archive_id AND r.person_id=m.right_person_id
    WHERE m.id=$1`;
  await client.query("SELECT set_config('drevo.archive_id','other-archive',false)");
  try {
    await assert.rejects(client.query(insert, [matchId,"Пояснение отправителя"]),
    (error: unknown) => (error as { code?: string }).code === "42501",
    "the initiating archive cannot author the recipient's explanation");
  } finally {
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  }
  await assert.rejects(client.query(insert, [matchId,"Позднее пояснение"]),
  (error: unknown) => (error as { code?: string }).code === "42501",
  "the recipient cannot append an explanation after its decision transaction");
  console.log("runtime_discovery_match_decision_note_late_insert_ok");
}

export async function verifyLegacyDecisionCannotReopen(client: pg.Client, matchId: string) {
  await assert.rejects(client.query(`INSERT INTO discovery_match_requests(
    id,left_archive_id,left_person_id,right_archive_id,right_person_id,
    initiated_by_archive_id,requested_by,status,decision_txid)
    SELECT $2,left_archive_id,left_person_id,right_archive_id,right_person_id,
      initiated_by_archive_id,requested_by,status,txid_current()
    FROM discovery_match_requests WHERE id=$1`, [matchId,randomUUID()]),
  (error: unknown) => (error as { code?: string }).code === "42501",
  "a direct terminal INSERT cannot mint a note transaction");
  await assert.rejects(client.query(`UPDATE discovery_match_requests SET status='pending'
    WHERE id=$1`, [matchId]),
  (error: unknown) => (error as { code?: string }).code === "42501",
  "a terminal match without decision_txid cannot be reset to pending to mint a late note");
  console.log("runtime_discovery_match_decision_note_legacy_guard_ok");
}

export async function verifyRevocableDecisionNote(db: StoreDatabase, matchId: string,
  securedBase: string, matchPath: string, senderHeaders: HeadersInit) {
  assert.equal(await savedNote(db, matchId), "Сравнены открытые карточки");
  assert.equal((await fetch(securedBase + matchPath, {
    method: "PATCH", headers: senderHeaders,
    body: JSON.stringify({ decision: "revoke", note: "Попытка заменить пояснение" }),
  })).status, 400, "a revocation cannot replace the response explanation");
}

export async function verifyRevokedDecisionNote(db: StoreDatabase, matchId: string,
  securedBase: string, senderHeaders: HeadersInit) {
  assert.equal((await db.prepare("", `SELECT count(*)::int AS n
    FROM discovery_match_decision_notes WHERE match_id=?`).get(matchId))?.n, 0,
  "a revoked link hides the retained explanation from participant SQL");
  const list = await fetch(securedBase + "/api/discovery/matches", { headers: senderHeaders });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).matches.find((item: { id: string }) =>
    item.id === matchId)?.decisionNote, undefined,
  "a revoked link cannot continue delivering its explanation");
}

export async function verifyWithdrawnDecisionNotes(db: StoreDatabase,
  acceptedId: string, rejectedId: string, otherBase: string, recipientHeaders: HeadersInit) {
  assert.equal((await db.prepare("", `SELECT count(*)::int AS n
    FROM discovery_match_decision_notes WHERE match_id IN (?,?)`)
    .get(acceptedId,rejectedId))?.n, 0,
  "withdrawn publications hide accepted and rejected explanations through RLS");
  const list = await fetch(otherBase + "/api/discovery/matches", { headers: recipientHeaders });
  assert.equal(list.status, 200);
  for (const item of (await list.json()).matches as { id: string; decisionNote?: string }[]) {
    if (item.id === acceptedId || item.id === rejectedId)
      assert.equal(item.decisionNote, undefined,
        "withdrawn publications cannot reveal old free text over HTTP");
  }
  console.log("runtime_discovery_match_decision_note_ok");
}
