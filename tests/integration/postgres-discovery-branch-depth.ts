import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { openArchive } from "../../src/server/database.ts";
import type { createAuth } from "../../src/server/auth.ts";
import { discoveryBranchShareHttp } from "../../src/server/discovery-branch-share-http.ts";
import { publishedPeopleStore } from "../../src/server/published-people.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";

type Archive = Awaited<ReturnType<typeof openArchive>>;
type Auth = Awaited<ReturnType<typeof createAuth>>;
type Option = { id: string; name: string; previewToken: string };
type Options = { options: Option[]; nextCursor: string | null };

export async function verifyDiscoveryBranchDepth(args: {
  archive: Archive; auth: Auth; sourceBase: string; recipientBase: string;
  ownerHeaders: Record<string,string>; recipientHeaders: Record<string,string>;
  branchPath: string; publicOrigin?: string;
}) {
  const { archive, auth, sourceBase, recipientBase, ownerHeaders,
    recipientHeaders, branchPath, publicOrigin } = args;
  const db = archive.db;
  const publication = publishedPeopleStore(db);
  const original = await archive.read();
  let requestNumber = 30;
  const headers = () => ({ ...ownerHeaders, "X-Real-IP": `203.0.113.${requestNumber++}` });
  const optionsPath = `${branchPath}/options/branch-grandparent-a`;
  const getOptions = async (after?: string) => {
    const response = await fetch(sourceBase + optionsPath +
      (after ? `?after=${encodeURIComponent(after)}` : ""), { headers: headers() });
    assert.equal(response.status, 200);
    return response.json() as Promise<Options>;
  };
  const append = (personId: string, previewToken: string) => fetch(sourceBase + optionsPath, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ personId, previewToken }),
  });
  const grant = async () => {
    const preview = await fetch(sourceBase + branchPath, { headers: headers() })
      .then((response) => response.json());
    assert.equal((await fetch(sourceBase + branchPath, { method: "PUT", headers: headers(),
      body: JSON.stringify({ personIds: ["branch-parent-a","branch-grandparent-a"],
        previewToken: preview.previewToken, recipientArchiveId: "other-archive",
        durationDays: 7 }),
    })).status, 200);
  };
  try {
    const family = structuredClone(original.family);
    const grandparent = family.people.find((person) => person.id === "branch-grandparent-a");
    assert.ok(grandparent);
    grandparent.parents = ["branch-great-a","branch-hidden-great-a"];
    const template = structuredClone(grandparent);
    for (const [id,name] of [["branch-great-a","Опубликованный прадед"],
      ["branch-hidden-great-a","Закрытый прадед"]] as const)
      family.people.push({ ...structuredClone(template), id, name, birth: "1890",
        deceased: true, parents: [], spouses: [], generation: 4 });
    const siblings = Array.from({ length: 31 }, (_, index) =>
      `branch-depth-${String(index).padStart(2,"0")}`);
    siblings[29] = "branch-depth-Я";
    siblings[30] = "branch-depth-a";
    for (const id of siblings)
      family.people.push({ ...structuredClone(template), id, name: `Опубликованный ${id}`,
        birth: "1950", deceased: true, parents: ["branch-grandparent-a"],
        spouses: [], generation: 2 });
    await archive.write(family, original.revision);
    await publication.publish("branch-great-a","owner");
    for (const id of siblings) await publication.publish(id,"owner");
    assert.equal((await fetch(sourceBase + optionsPath, { headers: headers() })).status, 404,
      "an archive edit revokes the source branch grant before expansion");
    await grant();
    assert.equal((await fetch(sourceBase + `${branchPath}/options/person-a`,
      { headers: headers() })).status, 404,
    "the root is not a previously selected step");
    for (const method of ["PUT","DELETE"])
      assert.equal((await fetch(sourceBase + optionsPath,
        { method, headers: headers() })).status, 405);
    const first = await getOptions();
    assert.equal(first.options.length, 30);
    assert.ok(first.nextCursor);
    const second = await getOptions(first.nextCursor!);
    const all = [...first.options,...second.options];
    assert.equal(all.length, 32);
    assert.equal(new Set(all.map((person) => person.id)).size, all.length,
      "C-collated keyset does not duplicate mixed-case or Unicode IDs");
    assert.ok(all.some((person) => person.id === "branch-depth-Я"));
    assert.ok(all.some((person) => person.id === "branch-depth-a"));
    assert.ok(all.some((person) => person.id === "branch-great-a"));
    assert.doesNotMatch(JSON.stringify(all), /branch-hidden-great-a|Закрытый прадед/);
    const great = all.find((person) => person.id === "branch-great-a")!;
    assert.equal((await append(great.id,"0".repeat(64))).status, 409);
    assert.equal((await append("branch-hidden-great-a",great.previewToken)).status, 409);
    assert.equal((await append(great.id,great.previewToken)).status, 200);
    assert.equal((await append(great.id,great.previewToken)).status, 409,
      "a selected person cannot be inserted twice via another path");
    const candidate = async (id: string) => {
      const options = await getOptions();
      const choice = options.options.find((person) => person.id === id);
      assert.ok(choice);
      return choice;
    };
    const viaVersion = await candidate("branch-depth-00");
    await publication.publish("branch-grandparent-a","owner");
    assert.equal((await append(viaVersion.id,viaVersion.previewToken)).status, 409,
      "changing the selected via publication invalidates the expansion token");
    const rootVersion = await candidate("branch-depth-01");
    await publication.publish("person-a","owner");
    assert.equal((await append(rootVersion.id,rootVersion.previewToken)).status, 409,
      "changing the linked root publication invalidates the expansion token");
    const candidateVersion = await candidate("branch-depth-02");
    await publication.publish(candidateVersion.id,"owner");
    assert.equal((await append(candidateVersion.id,candidateVersion.previewToken)).status, 409,
      "changing the candidate publication invalidates the expansion token");
    for (let index = 0; index < 17; index++) {
      const id = `branch-depth-${String(index).padStart(2,"0")}`;
      const fresh = await candidate(id);
      assert.equal((await append(id,fresh.previewToken)).status, 200);
    }
    const overCap = await candidate("branch-depth-17");
    assert.equal((await append(overCap.id,overCap.previewToken)).status, 409,
      "a 21st chosen member cannot be added even with a fresh preview");
    const recipientView = await fetch(recipientBase + branchPath,
      { headers: recipientHeaders }).then((response) => response.json());
    assert.ok(recipientView.incoming.some((person: { id: string; viaId: string }) =>
      person.id === great.id && person.viaId === "branch-grandparent-a"));
    assert.equal((await fetch(recipientBase + `${branchPath}/people/${great.id}`,
      { headers: recipientHeaders })).status, 200);
    await db.transaction(async () => {
      await db.prepare("", "SELECT set_config('drevo.archive_id','third-archive',true)").get();
      assert.equal((await db.prepare("", `SELECT count(*)::int AS count
        FROM discovery_branch_members WHERE person_id=?`).get(great.id))?.count, 0,
      "a third archive's RLS scope cannot read the selected path");
    }, true);
    // A completed owner approval revoke before the final lock denies a queued GET.
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const endpoint = discoveryBranchShareHttp({ archive, auth, publicOrigin,
      beforeOptionsAccessLock: async () => { entered(); await gate; } });
    const server = createServer((req,res) => {
      void endpoint(req,res,new URL(req.url || "/",`http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
    const pausedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${optionsPath}`;
    const paused = fetch(pausedUrl,{ headers: headers() });
    try {
      await ready;
      await db.prepare("", `UPDATE archive_memberships SET approved=false
        WHERE archive_id='runtime-test' AND user_id='owner'`).run();
      release();
      assert.equal((await paused).status, 403);
    } finally {
      release();
      await paused.catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.prepare("", `UPDATE archive_memberships SET approved=true
        WHERE archive_id='runtime-test' AND user_id='owner'`).run();
    }
    const revokedToken = newSessionToken();
    const revokedHash = sessionTokenHash(revokedToken);
    await db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES(?,'owner',?)`).run(revokedHash,Date.now() + 60_000);
    let sessionEntered!: () => void, releaseSession!: () => void;
    const sessionReady = new Promise<void>((resolve) => { sessionEntered = resolve; });
    const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
    const sessionEndpoint = discoveryBranchShareHttp({ archive, auth, publicOrigin,
      beforeOptionsAccessLock: async () => { sessionEntered(); await sessionGate; } });
    const sessionServer = createServer((req,res) => {
      void sessionEndpoint(req,res,new URL(req.url || "/",`http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => sessionServer.listen(0,"127.0.0.1",resolve));
    const revokedRequest = fetch(`http://127.0.0.1:${(sessionServer.address() as AddressInfo).port}${optionsPath}`,
      { headers: { ...headers(), Cookie: `drevo_session=${revokedToken}` } });
    try {
      await sessionReady;
      await db.prepare("", "DELETE FROM account_sessions WHERE token_hash=?").run(revokedHash);
      releaseSession();
      assert.equal((await revokedRequest).status, 403,
        "a completed logout before the final read lock cannot return options");
    } finally {
      releaseSession();
      await revokedRequest.catch(() => {});
      await new Promise<void>((resolve) => sessionServer.close(() => resolve()));
      await db.prepare("", "DELETE FROM account_sessions WHERE token_hash=?").run(revokedHash);
    }
    // An intermediate withdrawal cannot commit between path validation and
    // delivery. After delivery it cascades through all deeper steps.
    let publicationEntered!: () => void, releasePublication!: () => void;
    const publicationReady = new Promise<void>((resolve) => { publicationEntered = resolve; });
    const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
    const publicationEndpoint = discoveryBranchShareHttp({ archive, auth, publicOrigin,
      beforeOptionsDelivery: async () => { publicationEntered(); await publicationGate; } });
    const publicationServer = createServer((req,res) => {
      void publicationEndpoint(req,res,new URL(req.url || "/",`http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => publicationServer.listen(0,"127.0.0.1",resolve));
    const pendingOptions = fetch(`http://127.0.0.1:${(publicationServer.address() as AddressInfo).port}${optionsPath}`,
      { headers: headers() });
    let unpublish: Promise<void> | undefined;
    try {
      await publicationReady;
      unpublish = publication.unpublish("branch-grandparent-a");
      assert.equal(await Promise.race([unpublish.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"),100))]),
      "pending", "withdrawal of an intermediate publication waits for option delivery");
      releasePublication();
      assert.equal((await pendingOptions).status, 200);
      await unpublish;
    } finally {
      releasePublication();
      await pendingOptions.catch(() => {});
      await unpublish?.catch(() => {});
      await new Promise<void>((resolve) => publicationServer.close(() => resolve()));
    }
    assert.equal((await fetch(recipientBase + `${branchPath}/people/${great.id}`,
      { headers: recipientHeaders })).status, 404);
    assert.equal((await append("branch-depth-00",
      all.find((person) => person.id === "branch-depth-00")!.previewToken)).status, 404);
    assert.equal((await db.prepare("", `SELECT count(*)::int AS count
      FROM discovery_branch_members WHERE person_id=?`).get(great.id))?.count, 0);
    await publication.publish("branch-grandparent-a","owner");
    await grant();
    assert.equal((await db.prepare("", `UPDATE discovery_branch_grants
      SET expires_at=now()-interval '1 second' WHERE grantor_archive_id='runtime-test'
        AND left_person_id='person-a' AND right_person_id='person-a'`).run()).changes, 1);
    const expired = await fetch(sourceBase + optionsPath, { headers: headers() });
    assert.notEqual(expired.status, 200,
      "an expired source grant cannot enumerate another step");
    assert.doesNotMatch(await expired.text(), /Опубликованный/);
    const afterExpiry = await fetch(recipientBase + branchPath,
      { headers: recipientHeaders }).then((response) => response.json());
    assert.deepEqual(afterExpiry.incoming, [],
      "the other side loses selected members as soon as consent expires");
    await grant();
    let deliveryEntered!: () => void, releaseDelivery!: () => void;
    const deliveryReady = new Promise<void>((resolve) => { deliveryEntered = resolve; });
    const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const deliveryEndpoint = discoveryBranchShareHttp({ archive, auth, publicOrigin,
      beforeOptionsDelivery: async () => { deliveryEntered(); await deliveryGate; } });
    const deliveryServer = createServer((req,res) => {
      void deliveryEndpoint(req,res,new URL(req.url || "/",`http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => deliveryServer.listen(0,"127.0.0.1",resolve));
    const delayed = fetch(`http://127.0.0.1:${(deliveryServer.address() as AddressInfo).port}${optionsPath}`,
      { headers: headers() });
    let revoke: Promise<Response> | undefined;
    try {
      await deliveryReady;
      revoke = fetch(sourceBase + branchPath,
        { method: "DELETE", headers: headers() });
      assert.equal(await Promise.race([revoke.then((response) => `completed ${response.status}`),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"),100))]),
      "pending", "a concurrent revoke waits until the selected options are sent");
      releaseDelivery();
      assert.equal((await delayed).status, 200);
      assert.equal((await revoke).status, 200);
      assert.notEqual((await fetch(sourceBase + optionsPath,
        { headers: headers() })).status, 200,
      "the next request cannot reuse a revoked expansion grant");
    } finally {
      releaseDelivery();
      await delayed.catch(() => {});
      await revoke?.catch(() => {});
      await new Promise<void>((resolve) => deliveryServer.close(() => resolve()));
    }
    await grant();
    const successor = "branch-depth-successor";
    await db.prepare("", `INSERT INTO accounts(id,name,created_at)
      VALUES(?,? ,now()) ON CONFLICT (id) DO NOTHING`).run(successor,"Synthetic successor");
    await db.prepare("", `INSERT INTO archive_memberships
      (archive_id,user_id,role,approved,tree_access)
      VALUES('runtime-test',?,'relative',true,'all')
      ON CONFLICT (archive_id,user_id) DO UPDATE SET approved=true`).run(successor);
    let transferEntered!: () => void, releaseTransfer!: () => void;
    const transferReady = new Promise<void>((resolve) => { transferEntered = resolve; });
    const transferGate = new Promise<void>((resolve) => { releaseTransfer = resolve; });
    const transferEndpoint = discoveryBranchShareHttp({ archive, auth, publicOrigin,
      beforeOptionsAccessLock: async () => { transferEntered(); await transferGate; } });
    const transferServer = createServer((req,res) => {
      void transferEndpoint(req,res,new URL(req.url || "/",`http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => transferServer.listen(0,"127.0.0.1",resolve));
    const oldOwnerRead = fetch(`http://127.0.0.1:${(transferServer.address() as AddressInfo).port}${optionsPath}`,
      { headers: headers() });
    try {
      await transferReady;
      assert.equal((await db.prepare("", `UPDATE archive_owners SET user_id=?
        WHERE archive_id='runtime-test' AND user_id='owner'`).run(successor)).changes, 1);
      releaseTransfer();
      assert.equal((await oldOwnerRead).status, 403,
        "a completed transfer before the final owner lock denies the old owner");
    } finally {
      releaseTransfer();
      await oldOwnerRead.catch(() => {});
      await new Promise<void>((resolve) => transferServer.close(() => resolve()));
      await db.prepare("", `UPDATE archive_owners SET user_id='owner'
        WHERE archive_id='runtime-test' AND user_id=?`).run(successor);
      await db.prepare("", `DELETE FROM archive_memberships
        WHERE archive_id='runtime-test' AND user_id=?`).run(successor);
      await db.prepare("", "DELETE FROM accounts WHERE id=?").run(successor);
    }
  } finally {
    const current = await archive.read();
    await archive.write(original.family,current.revision);
    await publication.publish("branch-grandparent-a","owner");
    await grant();
  }
  console.log("runtime_discovery_branch_depth_ok");
}
