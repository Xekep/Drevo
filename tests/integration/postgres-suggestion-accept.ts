import assert from "node:assert/strict";
import type pg from "pg";
import type { openArchive } from "../../src/server/database.ts";
import { researchSuggestionStore } from "../../src/server/research-suggestions.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyAtomicSuggestionAcceptance(
  archive: Awaited<ReturnType<typeof openArchive>>,
  client: pg.Client,
  base: string,
  headers: Record<string, string>,
) {
  const actor = await (await userStore(archive.db)).get("owner");
  assert.ok(actor);
  const suggestions = researchSuggestionStore(archive.db);
  const originalRead = archive.read;
  const originalWrite = archive.write;
  const initial = await originalRead();
  const initialBiography = initial.family.people.find(
    (person) => person.id === "person-a",
  )?.biography;
  const create = async (label: string) => {
    const snapshot = await originalRead();
    return suggestions.createPersonUpdate(
      actor,
      snapshot.family,
      snapshot.revision,
      {
        personId: "person-a",
        changes: { biography: label },
        reason: `atomic-suggestion-${label}`,
      },
    );
  };
  const action = (id: string, decision: "accept" | "reject") =>
    fetch(`${base}/api/research/suggestions/${id}/${decision}`, {
      method: "POST",
      headers,
    });
  const assertUnchanged = async (
    revision: number,
    biography: string | undefined,
  ) => {
    const snapshot = await originalRead();
    assert.equal(
      snapshot.revision,
      revision,
      "a failed accept must roll back the archive revision",
    );
    assert.equal(
      snapshot.family.people.find((person) => person.id === "person-a")
        ?.biography,
      biography,
      "a failed accept must roll back the person update",
    );
  };

  const rejectedFirst = await create("reject-wins");
  const beforeReject = await originalRead();
  let rejectedWhileAccepting = false;
  archive.read = async () => {
    const snapshot = await originalRead();
    const response = await action(rejectedFirst.id, "reject");
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).suggestion.status, "rejected");
    rejectedWhileAccepting = true;
    return snapshot;
  };
  try {
    const response = await action(rejectedFirst.id, "accept");
    assert.equal(rejectedWhileAccepting, true);
    assert.equal(response.status, 409, await response.clone().text());
    await assertUnchanged(
      beforeReject.revision,
      beforeReject.family.people.find((person) => person.id === "person-a")
        ?.biography,
    );
    assert.equal(
      (await suggestions.get(actor, rejectedFirst.id))?.status,
      "rejected",
    );
  } finally {
    archive.read = originalRead;
    await archive.db
      .prepare("", "DELETE FROM research_suggestions WHERE id=?")
      .run(rejectedFirst.id);
  }

  const acceptedFirst = await create("accept-wins");
  const beforeAccept = await originalRead();
  let notifyMarked!: () => void;
  let releaseMarked!: () => void;
  const marked = new Promise<void>((resolve) => {
    notifyMarked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseMarked = resolve;
  });
  archive.write = async (...args) => {
    const afterWrite = args[6];
    args[6] = async (db) => {
      await afterWrite?.(db);
      notifyMarked();
      await gate;
    };
    return originalWrite(...args);
  };
  try {
    const accepting = action(acceptedFirst.id, "accept");
    await Promise.race([
      marked,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("accept did not reach mark")),
          15_000,
        ),
      ),
    ]);
    const rejecting = action(acceptedFirst.id, "reject");
    let sawLock = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const result =
        await client.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND wait_event_type='Lock' AND query LIKE 'UPDATE research_suggestions%'`);
      if (result.rows[0].n > 0) {
        sawLock = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      sawLock,
      true,
      "reject must wait for the uncommitted accept status update",
    );
    releaseMarked();
    const acceptedResponse = await accepting;
    const rejectedResponse = await rejecting;
    assert.equal(
      acceptedResponse.status,
      200,
      await acceptedResponse.clone().text(),
    );
    const acceptedBody = await acceptedResponse.json();
    assert.equal(acceptedBody.suggestion.status, "accepted");
    assert.equal(acceptedBody.revision, beforeAccept.revision + 1);
    assert.equal(
      rejectedResponse.status,
      409,
      await rejectedResponse.clone().text(),
    );
    assert.equal(
      (await action(acceptedFirst.id, "accept")).status,
      409,
      "repeating accept cannot apply the suggestion twice",
    );
    const afterAccept = await originalRead();
    assert.equal(
      afterAccept.family.people.find((person) => person.id === "person-a")
        ?.biography,
      "accept-wins",
    );
    assert.equal(
      (await suggestions.get(actor, acceptedFirst.id))?.status,
      "accepted",
    );
  } finally {
    releaseMarked();
    archive.write = originalWrite;
    await archive.db
      .prepare("", "DELETE FROM research_suggestions WHERE id=?")
      .run(acceptedFirst.id);
  }

  const failedMark = await create("mark-failure");
  const beforeFailure = await originalRead();
  await client.query(`CREATE FUNCTION runtime_test_fail_suggestion_mark() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.reason='atomic-suggestion-mark-failure' AND NEW.status='accepted' THEN
        RAISE EXCEPTION 'forced suggestion mark failure';
      END IF;
      RETURN NEW;
    END $$`);
  await client.query(`CREATE TRIGGER runtime_test_fail_suggestion_mark
    BEFORE UPDATE OF status ON research_suggestions FOR EACH ROW
    EXECUTE FUNCTION runtime_test_fail_suggestion_mark()`);
  try {
    const response = await action(failedMark.id, "accept");
    assert.equal(
      response.status,
      500,
      "failed status persistence must report a server error, not success",
    );
    assert.doesNotMatch(
      await response.text(),
      /forced suggestion mark failure/,
      "the API must not expose SQL diagnostics",
    );
    await assertUnchanged(
      beforeFailure.revision,
      beforeFailure.family.people.find((person) => person.id === "person-a")
        ?.biography,
    );
    assert.equal(
      (await suggestions.get(actor, failedMark.id))?.status,
      "pending",
    );
  } finally {
    await client.query(
      "DROP TRIGGER runtime_test_fail_suggestion_mark ON research_suggestions",
    );
    await client.query("DROP FUNCTION runtime_test_fail_suggestion_mark()");
    await archive.db
      .prepare("", "DELETE FROM research_suggestions WHERE id=?")
      .run(failedMark.id);
  }

  const after = await originalRead();
  const restoredPeople = after.family.people.map((person) => {
    if (person.id !== "person-a") return person;
    const restored = { ...person };
    if (initialBiography === undefined) delete restored.biography;
    else restored.biography = initialBiography;
    return restored;
  });
  await originalWrite(
    { ...after.family, people: restoredPeople },
    after.revision,
    actor,
    "test_restore_suggestion_person",
  );
}
