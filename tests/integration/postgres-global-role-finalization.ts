import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  applyGlobalStaffRoles,
  inventoryGlobalStaffRoles,
  validateGlobalStaffRoles,
} from "../../ops/postgres/finalize-global-staff-roles.ts";

/** Runs at the end of the disposable full PostgreSQL fixture. */
export async function verifyGlobalRoleFinalization() {
  const adminOptions = process.env.PGADMINUSER
    ? { user: process.env.PGADMINUSER, password: process.env.PGADMINPASSWORD }
    : {};
  const admin = new pg.Client(adminOptions);
  const blocker = new pg.Client(adminOptions);
  const runtime = new pg.Client();
  await Promise.all([admin.connect(), blocker.connect(), runtime.connect()]);
  const suffix = randomUUID();
  const archiveId = `role-finalization-${suffix}`;
  const accountId = `role-finalization-owner-${suffix}`;
  const unknownId = `role-finalization-unknown-${suffix}`;
  const staffId = `role-finalization-staff-${suffix}`;
  let blocked = false;
  try {
    assert.equal((await admin.query<{ privileged: boolean }>(
      "SELECT rolsuper OR rolbypassrls AS privileged FROM pg_roles WHERE rolname=current_user"
    )).rows[0].privileged, true, "the fixture needs a privileged operator connection");
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL row_security=off");
      await admin.query("ALTER TABLE public.archive_memberships DROP CONSTRAINT archive_memberships_role_check");
      await admin.query(`ALTER TABLE public.archive_memberships
        DISABLE TRIGGER normalize_archive_member_role_before_write`);
      await admin.query(`INSERT INTO public.archives
        (id,title,description,demo,revision,sqlite_schema_version)
        VALUES($1,'Validation fixture','',false,0,1)`, [archiveId]);
      await admin.query(`INSERT INTO public.people(archive_id,id,ordinal,data)
        VALUES($1,'role-fixture-person',1,'{"id":"role-fixture-person"}'::jsonb)`, [archiveId]);
      await admin.query(`INSERT INTO public.accounts(id,name,created_at)
        VALUES($1,'Fixture owner',now()::text),($2,'Fixture unknown',now()::text),
          ($3,'Existing global staff',now()::text)`, [accountId, unknownId, staffId]);
      await admin.query("INSERT INTO public.platform_researchers(account_id) VALUES($1)", [staffId]);
      await admin.query(`INSERT INTO public.platform_role_audit
        (actor_id,target_id,old_role,new_role) VALUES($1,$1,NULL,'researcher')`, [staffId]);
      await admin.query(`INSERT INTO public.archive_memberships
        (archive_id,user_id,role,approved,person_id,tree_access)
        VALUES('runtime-test',$1,'researcher',false,NULL,'all'),
          ($2,$1,'admin',true,'role-fixture-person','common_ancestors'),
          ($2,$3,'mystery',false,NULL,'all')`, [accountId, archiveId, unknownId]);
      await admin.query(`INSERT INTO public.archive_owners(archive_id,user_id)
        VALUES($1,$2)`, [archiveId, accountId]);
      await admin.query(`ALTER TABLE public.archive_memberships
        ENABLE TRIGGER normalize_archive_member_role_before_write`);
      await admin.query(`ALTER TABLE public.archive_memberships
        ADD CONSTRAINT archive_memberships_role_check
        CHECK (role IN ('reader','relative')) NOT VALID`);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }

    const before = await admin.query(`SELECT archive_id,user_id,role,approved,person_id,tree_access
      FROM public.archive_memberships WHERE user_id=$1 ORDER BY archive_id`, [accountId]);
    const ownerBefore = await admin.query(`SELECT archive_id,user_id FROM public.archive_owners
      WHERE archive_id=$1`, [archiveId]);
    const grantsBefore = [
      await admin.query("SELECT * FROM public.platform_admins ORDER BY account_id"),
      await admin.query("SELECT * FROM public.platform_researchers ORDER BY account_id"),
      await admin.query("SELECT * FROM public.platform_role_audit ORDER BY id"),
    ];
    assert.equal(grantsBefore[1].rows.some((row) => row.account_id === staffId), true,
      "the snapshot includes an existing unrelated global grant");
    const initial = await inventoryGlobalStaffRoles(admin);
    assert.equal(initial.legacyAdmin, "1");
    assert.equal(initial.legacyResearcher, "1");
    assert.equal(initial.unknown, "1");
    assert.equal(initial.validated, false);
    await assert.rejects(applyGlobalStaffRoles(admin), /неизвестные местные роли/i);
    await assert.rejects(validateGlobalStaffRoles(admin), /несовместимые местные роли/i);
    assert.deepEqual((await admin.query(`SELECT archive_id,user_id,role,approved,person_id,tree_access
      FROM public.archive_memberships WHERE user_id=$1 ORDER BY archive_id`, [accountId])).rows,
    before.rows, "an unknown role fails closed before changing a known legacy grant");

    await assert.rejects(inventoryGlobalStaffRoles(runtime), /SUPERUSER или BYPASSRLS/);
    await runtime.query("BEGIN");
    try {
      await runtime.query("SET LOCAL row_security=off");
      await assert.rejects(runtime.query("SELECT count(*) FROM public.archive_memberships"),
        (error: unknown) => (error as { code?: string }).code === "42501",
        "ordinary runtime role cannot turn a filtered inventory into an all-archive scan");
    } finally {
      await runtime.query("ROLLBACK");
    }

    await admin.query("DELETE FROM public.archive_memberships WHERE archive_id=$1 AND user_id=$2",
      [archiveId, unknownId]);
    await blocker.query("BEGIN");
    blocked = true;
    await blocker.query("SELECT pg_advisory_xact_lock(186743291)");
    const busyAt = Date.now();
    await assert.rejects(applyGlobalStaffRoles(admin), /Миграция 090 занята/);
    await assert.rejects(validateGlobalStaffRoles(admin), /Миграция 090 занята/);
    assert.ok(Date.now() - busyAt < 2500,
      "both commands fail promptly behind an active migration lock");
    assert.deepEqual((await admin.query(`SELECT archive_id,user_id,role,approved,person_id,tree_access
      FROM public.archive_memberships WHERE user_id=$1 ORDER BY archive_id`, [accountId])).rows,
    before.rows, "a busy migration lock changes no local grant");
    await blocker.query("ROLLBACK");
    blocked = false;

    await blocker.query("BEGIN");
    blocked = true;
    await blocker.query(`SELECT role FROM public.archive_memberships
      WHERE archive_id=$1 AND user_id=$2 FOR UPDATE`, [archiveId, accountId]);
    const partial = await applyGlobalStaffRoles(admin, { batchSize: 1, maxBatches: 2 });
    assert.equal(partial.updated, 1);
    assert.equal(partial.complete, false,
      "SKIP LOCKED must not report completion while the last old row is busy");
    assert.equal(partial.remaining.legacyAdmin, "1");
    assert.equal(partial.remaining.legacyResearcher, "0");
    await assert.rejects(validateGlobalStaffRoles(admin), /несовместимые местные роли/i);
    assert.equal((await admin.query(`SELECT convalidated FROM pg_constraint
      WHERE conrelid='public.archive_memberships'::regclass
        AND conname='archive_memberships_role_check'`)).rows[0].convalidated, false);
    await blocker.query("ROLLBACK");
    blocked = false;

    const complete = await applyGlobalStaffRoles(admin, { batchSize: 1, maxBatches: 1 });
    assert.equal(complete.updated, 1);
    assert.equal(complete.complete, true);
    const after = await admin.query(`SELECT archive_id,user_id,role,approved,person_id,tree_access
      FROM public.archive_memberships WHERE user_id=$1 ORDER BY archive_id`, [accountId]);
    assert.deepEqual(after.rows, before.rows.map((row) => ({ ...row, role: "relative" })),
      "only the local role changes; identity, approval and tree scope survive");
    assert.deepEqual((await admin.query(`SELECT archive_id,user_id FROM public.archive_owners
      WHERE archive_id=$1`, [archiveId])).rows, ownerBefore.rows);
    const grantsAfter = [
      await admin.query("SELECT * FROM public.platform_admins ORDER BY account_id"),
      await admin.query("SELECT * FROM public.platform_researchers ORDER BY account_id"),
      await admin.query("SELECT * FROM public.platform_role_audit ORDER BY id"),
    ];
    assert.deepEqual(grantsAfter.map((result) => result.rows),
      grantsBefore.map((result) => result.rows), "global grants and audit rows are unchanged exactly");
    assert.equal((await validateGlobalStaffRoles(admin)).validated, true);
    assert.equal((await validateGlobalStaffRoles(admin)).validated, true,
      "validation is repeatable after an already validated CHECK");
    assert.equal((await applyGlobalStaffRoles(admin)).updated, 0);
    await admin.query(`INSERT INTO public.archive_memberships
      (archive_id,user_id,role,approved,person_id,tree_access)
      VALUES($1,$2,'admin',false,NULL,'all')`, [archiveId, unknownId]);
    assert.equal((await admin.query(`SELECT role FROM public.archive_memberships
      WHERE archive_id=$1 AND user_id=$2`, [archiveId, unknownId])).rows[0].role,
    "relative", "the normalizing trigger remains active after validation");
    await admin.query("DELETE FROM public.archive_memberships WHERE archive_id=$1 AND user_id=$2",
      [archiveId, unknownId]);
    verifySymlinkCli(adminOptions);
    console.log("runtime_global_role_finalization_ok");
  } finally {
    if (blocked) await blocker.query("ROLLBACK").catch(() => {});
    await admin.query("DELETE FROM public.archives WHERE id=$1", [archiveId]).catch(() => {});
    await admin.query("DELETE FROM public.archive_memberships WHERE archive_id='runtime-test' AND user_id=$1",
      [accountId]).catch(() => {});
    await admin.query("DELETE FROM public.platform_role_audit WHERE target_id=$1", [staffId]).catch(() => {});
    await admin.query("DELETE FROM public.accounts WHERE id IN ($1,$2,$3)",
      [accountId, unknownId, staffId]).catch(() => {});
    await Promise.all([admin.end(), blocker.end(), runtime.end()]);
  }
}

function verifySymlinkCli(adminOptions: { user?: string; password?: string }) {
  const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const temporary = mkdtempSync(join(tmpdir(), "drevo-global-roles-cli-"));
  const link = join(temporary, "release");
  try {
    symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
    const output = execFileSync(process.execPath,
      ["--experimental-strip-types", join(link, "ops/postgres/finalize-global-staff-roles.ts"), "inventory"],
      { cwd: root, env: { ...process.env, PGUSER: adminOptions.user || process.env.PGUSER,
        PGPASSWORD: adminOptions.password || process.env.PGPASSWORD },
      encoding: "utf8", timeout: 15_000 });
    const result = JSON.parse(output) as { mode: string; legacyAdmin: string; validated: boolean };
    assert.deepEqual(Object.keys(result).sort(),
      ["mode", "total", "legacyAdmin", "legacyResearcher", "unknown", "validated"].sort(),
      "operator output contains only aggregate fields");
    assert.doesNotMatch(output, /role-finalization-|Fixture owner|Existing global staff|https?:/);
    assert.equal(result.mode, "inventory");
    assert.equal(result.legacyAdmin, "0");
    assert.equal(result.validated, true);
    const denied = spawnSync(process.execPath,
      ["--experimental-strip-types", join(link, "ops/postgres/finalize-global-staff-roles.ts"), "inventory"],
      { cwd: root, env: process.env, encoding: "utf8", timeout: 15_000 });
    assert.equal(denied.status, 1, "an ordinary runtime login cannot run the CLI");
    assert.match(denied.stderr, /SUPERUSER или BYPASSRLS/);
    assert.doesNotMatch(denied.stderr, /role-finalization-|Fixture owner|Existing global staff|https?:/);
  } finally {
    if (realpathSync(link) === root) {
      if (process.platform === "win32") rmdirSync(link);
      else unlinkSync(link);
    }
    rmdirSync(temporary);
  }
}
