import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { openPostgresDatabase } from "../src/server/store-database.ts";

class BoundedPool {
  static latest: BoundedPool;
  options: pg.PoolConfig;
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  peak = 0;
  events: string[] = [];
  released: boolean[] = [];
  failUnlock = false;
  private waiters: Array<() => void> = [];
  constructor(options: pg.PoolConfig) {
    this.options = options;
    BoundedPool.latest = this;
  }
  on() {}
  async connect() {
    if (this.totalCount >= this.options.max!) {
      this.waitingCount++;
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          clearTimeout(timer);
          this.waitingCount--;
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((waiter) => waiter !== ready);
          this.waitingCount--;
          reject(new Error("bounded pool timeout"));
        }, 200);
        this.waiters.push(ready);
      });
    }
    this.totalCount++;
    this.peak = Math.max(this.peak, this.totalCount);
    let released = false;
    return {
      query: async (sql: string) => {
        assert.equal(released, false, "no SQL on released task client");
        this.events.push(sql);
        if (sql.includes("pg_advisory_unlock") && this.failUnlock)
          throw new Error("unlock failed");
        return {
          rows: sql.includes("pg_try_advisory_lock")
            ? [{ acquired: true }]
            : sql.includes("pg_advisory_unlock")
              ? [{ released: true }]
              : [{ value: 1 }],
          rowCount: 1,
        };
      },
      release: (discard = false) => {
        assert.equal(released, false);
        released = true;
        this.released.push(discard);
        this.totalCount--;
        this.waiters.shift()?.();
      },
    };
  }
  async query(sql: string) {
    if (sql.includes("FROM pg_roles"))
      return { rows: [{ rolsuper: false, rolbypassrls: false }] };
    if (sql.includes("SELECT id FROM archives"))
      return { rows: [{ id: "test-archive" }], rowCount: 1 };
    const client = await this.connect();
    try {
      return await client.query(sql);
    } finally {
      client.release();
    }
  }
  async end() {
    assert.equal(this.totalCount, 0);
  }
}

test("three queued task owners leave a foreground slot and reuse connections for nested locks and transactions", async (t) => {
  const original = pg.Pool;
  pg.Pool = BoundedPool as unknown as typeof pg.Pool;
  t.after(() => {
    pg.Pool = original;
  });
  const db = await openPostgresDatabase("test-archive", ":memory:");
  const pool = BoundedPool.latest;
  let entered = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  try {
    const pending = Promise.all(
      ["first", "second", "third"].map((name) =>
        db.withExclusivePlatformTask!(name, async () => {
          if (++entered === 2) reached();
          await gate;
          assert.equal(db.inTransaction(), false);
          await db.withExclusivePlatformTask!("nested-" + name, async () => {
            assert.equal(
              (await db.prepare("", "SELECT 1 AS value").get())?.value,
              1,
            );
            await db.transaction(async () => {
              assert.equal(db.inTransaction(), true);
              await db.prepare("", "SELECT 1 AS value").get();
              await assert.rejects(
                db.withExclusivePlatformTask!("forbidden", async () => {}),
                /transaction/,
              );
            });
            await db.postgresTransaction!(async (client) => {
              assert.equal(db.inTransaction(), true);
              await client.query("SELECT 1 AS value");
            });
          });
          return name;
        }),
      ),
    );
    await ready;
    try {
      assert.equal(entered, 2, "third task waits outside the pool");
      assert.equal(
        (await db.prepare("", "SELECT 'foreground' AS value").get())?.value,
        1,
        "ordinary requests keep a free connection while long tasks own locks",
      );
    } finally {
      release();
    }
    const results = await pending;
    assert.deepEqual(results, ["first", "second", "third"]);
    assert.equal(pool.peak, 3);
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.waitingCount, 0);
    assert.ok(pool.released.every((discard) => !discard));
  } finally {
    await db.close();
  }
});

test("an explicit permission transaction can start an independent file task", async (t) => {
  const original = pg.Pool;
  pg.Pool = BoundedPool as unknown as typeof pg.Pool;
  t.after(() => {
    pg.Pool = original;
  });
  const db = await openPostgresDatabase("test-archive", ":memory:");
  try {
    await db.postgresTransaction!(async (permissionClient) => {
      await permissionClient.query("SELECT 'permission' AS marker");
      assert.equal(db.inTransaction(), false);
      await db.withExclusivePlatformTask!("file-settings", async () => {
        await db.transaction(async () => {
          assert.equal(db.inTransaction(), true);
          await db.prepare("", "SELECT 'file-operation' AS marker").get();
        });
      });
    });
    assert.equal(BoundedPool.latest.peak, 2);
    assert.equal(BoundedPool.latest.totalCount, 0);
  } finally {
    await db.close();
  }
});

test("parallel task SQL waits outside another operation's short transaction", async (t) => {
  const original = pg.Pool;
  pg.Pool = BoundedPool as unknown as typeof pg.Pool;
  t.after(() => {
    pg.Pool = original;
  });
  const db = await openPostgresDatabase("test-archive", ":memory:");
  const pool = BoundedPool.latest;
  try {
    await db.withExclusiveArchiveTask!("import", async () => {
      pool.events = [];
      await Promise.all([
        db.transaction(async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          await db.prepare("", "SELECT 'inside' AS marker").get();
        }),
        db.prepare("", "SELECT 'outside' AS marker").get(),
      ]);
      assert.ok(
        pool.events.indexOf("COMMIT") <
          pool.events.indexOf("SELECT 'outside' AS marker"),
      );
      assert.equal(db.inTransaction(), false);
    });
  } finally {
    await db.close();
  }
});

test("task errors unlock sessions; failed unlock discards the client; detached SQL is rejected", async (t) => {
  const original = pg.Pool;
  pg.Pool = BoundedPool as unknown as typeof pg.Pool;
  t.after(() => {
    pg.Pool = original;
  });
  const db = await openPostgresDatabase("test-archive", ":memory:");
  const pool = BoundedPool.latest;
  try {
    await assert.rejects(
      db.withExclusiveArchiveTask!("failure", async () => {
        throw new Error("work failed");
      }),
      /work failed/,
    );
    assert.equal(pool.released.at(-1), false);
    let detached!: Promise<void>;
    await db.withExclusivePlatformTask!("detached", async () => {
      detached = new Promise((resolve, reject) => {
        setImmediate(() =>
          assert
            .rejects(db.prepare("", "SELECT 1").get(), /Контекст/)
            .then(resolve, reject),
        );
      });
    });
    await detached;
    pool.failUnlock = true;
    await assert.rejects(
      db.withExclusivePlatformTask!("unlock-failure", async () => true),
      /unlock failed/,
    );
    assert.equal(pool.released.at(-1), true);
  } finally {
    await db.close();
  }
});
