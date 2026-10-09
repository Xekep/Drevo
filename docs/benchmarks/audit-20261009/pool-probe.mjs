import pg from "pg";
let pool;
class BoundedPool {
  constructor(options) {
    this.options = options;
    this.totalCount = 0;
    this.idleCount = 0;
    this.waitingCount = 0;
    this.waiters = [];
    pool = this;
  }
  on() {}
  async connect() {
    if (this.totalCount >= this.options.max) {
      this.waitingCount++;
      await new Promise((resolve, reject) => {
        const waiter = {
          resolve: () => {
            clearTimeout(timer);
            this.waitingCount--;
            resolve();
          },
        };
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== waiter);
          this.waitingCount--;
          reject(new Error("synthetic connection timeout"));
        }, 200);
        this.waiters.push(waiter);
      });
    }
    this.totalCount++;
    let released = false;
    return {
      query: async (sql) => ({
        rows: sql.includes("pg_try_advisory_lock")
          ? [{ acquired: true }]
          : sql.includes("pg_advisory_unlock")
            ? [{ released: true }]
            : [{ value: 1 }],
        rowCount: 1,
      }),
      release: () => {
        if (released) return;
        released = true;
        this.totalCount--;
        this.waiters.shift()?.resolve();
      },
    };
  }
  async query(sql) {
    if (sql.includes("FROM pg_roles"))
      return { rows: [{ rolsuper: false, rolbypassrls: false }] };
    if (sql.includes("SELECT id FROM archives"))
      return { rows: [{ id: "audit-fixture" }], rowCount: 1 };
    const client = await this.connect();
    try {
      return await client.query(sql);
    } finally {
      client.release();
    }
  }
  async end() {}
}
const previous = pg.Pool;
pg.Pool = BoundedPool;
try {
  const { openPostgresDatabase } =
    await import("../../../src/server/store-database.ts");
  const db = await openPostgresDatabase("audit-fixture", ":memory:");
  let entered = 0,
    release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let reached;
  const ready = new Promise((resolve) => { reached = resolve; });
  const work = async () => {
    entered++;
    if (entered === 2) reached();
    await barrier;
    return db.prepare("", "SELECT 1 AS value").get();
  };
  const pending = Promise.allSettled(
    ["audit-one", "audit-two", "audit-three"].map((name) =>
      db.withExclusivePlatformTask(name, work),
    ),
  );
  await ready;
  let foreground;
  try { foreground = await db.prepare("", "SELECT 1 AS value").get(); }
  finally { release(); }
  const results = await pending;
  console.log(
    JSON.stringify({
      test: "actual store-database with synthetic bounded pool",
      poolLimit: pool.options.max,
      lockCallbacks: entered,
      foregroundReadSucceeded: foreground?.value === 1,
      fulfilled: results.filter((x) => x.status === "fulfilled").length,
      rejected: results
        .filter((x) => x.status === "rejected")
        .map((x) => x.reason.message),
      productionDatabaseUsed: false,
      timeoutMs: 200,
      realConfiguredConnectionTimeoutMs: pool.options.connectionTimeoutMillis,
    }),
  );
  await db.close();
} finally {
  pg.Pool = previous;
}
