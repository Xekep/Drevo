import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { initializePostgresRuntimeSchema } from "./postgres-runtime-schema.ts";

type Row = Record<string, unknown>;
export function postgresPoolSize(
  value = process.env.DREVO_PG_POOL_SIZE,
): number {
  if (value === undefined || value === "") return 3;
  if (!/^[3-9]$|^10$/.test(value))
    throw new Error("DREVO_PG_POOL_SIZE должен быть целым числом от 3 до 10");
  return Number(value);
}
export function configuredDatabaseBackend(file: string): "sqlite" | "postgres" {
  const backend = process.env.DATABASE_BACKEND || "sqlite";
  if (backend !== "sqlite" && backend !== "postgres")
    throw new Error("Неизвестный DATABASE_BACKEND");
  if (
    file !== ":memory:" &&
    backend !== "postgres" &&
    existsSync(join(dirname(file), "postgres.active"))
  )
    throw new Error(
      "Архив уже перенесён в PostgreSQL. Возврат к устаревшей SQLite запрещён.",
    );
  return backend;
}
type WriteResult = { changes: number; lastInsertRowid: number | bigint };
type Statement = {
  get(...values: SQLInputValue[]): Promise<Row | undefined>;
  all(...values: SQLInputValue[]): Promise<Row[]>;
  run(...values: SQLInputValue[]): Promise<WriteResult>;
};

/** The application owns SQL; this boundary owns connections and transactions.
 * Both dialects use positional ? bindings. A second, explicit statement
 * is required wherever the retained SQLite import/test dialect differs.
 */
export type StoreDatabase = {
  kind: "sqlite" | "postgres";
  file: string;
  archiveId?: string;
  prepare(sqlite: string, postgres?: string): Statement;
  exec(sqlite: string, postgres?: string): Promise<void>;
  transaction<T>(work: () => Promise<T>, readOnly?: boolean): Promise<T>;
  /** Global OAuth work uses its own transaction, without locking one tree. */
  postgresTransaction?<T>(
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T>;
  /** Session lock for long archive jobs; never keep a DB transaction open. */
  withExclusiveArchiveTask?<T>(
    task: string,
    work: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }>;
  /** One host-wide session lock for filesystem tasks shared by all archives. */
  withExclusivePlatformTask?<T>(
    task: string,
    work: () => Promise<T>,
  ): Promise<T>;
  inTransaction(): boolean;
  poolDiagnostics?(): {
    total: number;
    idle: number;
    waiting: number;
    limit: number;
  };
  close(): Promise<void>;
};

/** Only binding notation changes; SQL syntax is authored for each engine. */
export function postgresBindings(sql: string) {
  let result = "",
    index = 0,
    quote = "";
  for (let offset = 0; offset < sql.length; offset++) {
    const char = sql[offset];
    result += !quote && char === "?" ? "$" + ++index : char;
    if (quote && char === quote) {
      if (sql[offset + 1] === quote) result += sql[++offset];
      else quote = "";
    } else if (!quote && (char === "'" || char === '"')) quote = char;
  }
  if (quote) throw new Error("Unterminated SQL string");
  return result;
}

const connections = new WeakMap<DatabaseSync, StoreDatabase>();
export function storeDatabase(
  source: DatabaseSync | StoreDatabase,
): StoreDatabase {
  if (!(source instanceof DatabaseSync)) return source;
  const cached = connections.get(source);
  if (cached) return cached;
  // SQLite's built-in lower() only folds ASCII without ICU. Catalog searches
  // must also match Cyrillic archive names and abbreviations.
  source.function("drevo_lower", { deterministic: true }, (value: unknown) =>
    String(value ?? "").toLocaleLowerCase("ru"),
  );
  // Older binaries lack this function and fail closed at the relation triggers.
  source.function(
    "drevo_parent_evidence_writer",
    { deterministic: true },
    () => 1,
  );
  // Awaiting SQLite calls yields to other requests too. Serialize complete
  // transactions, not individual statements, and retain ownership across awaits.
  const context = new AsyncLocalStorage<{
    transaction: boolean;
    active: boolean;
  }>();
  let tail = Promise.resolve();
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const current = context.getStore();
    if (current) {
      if (!current.active) throw new Error("Контекст операции БД уже завершён");
      return await work();
    }
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((done) => {
      release = done;
    });
    await previous;
    const owner = { transaction: false, active: true };
    try {
      return await context.run(owner, work);
    } finally {
      owner.active = false;
      release();
    }
  }
  const main = source
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main");
  const database: StoreDatabase = {
    kind: "sqlite",
    file: String(main?.file || ""),
    inTransaction: () => !!context.getStore()?.transaction,
    prepare(sql) {
      const statement = source.prepare(sql);
      return {
        get: async (...values) =>
          await exclusive(async () => statement.get(...values)),
        all: async (...values) =>
          await exclusive(async () => statement.all(...values)),
        run: async (...values) =>
          await exclusive(async () => {
            const result = statement.run(...values);
            return {
              changes: Number(result.changes),
              lastInsertRowid: result.lastInsertRowid,
            };
          }),
      };
    },
    exec: async (sql) =>
      await exclusive(async () => {
        source.exec(sql);
      }),
    transaction: async (work, readOnly = false) =>
      await exclusive(async () => {
        const owner = context.getStore()!;
        if (owner.transaction) {
          if (readOnly) return await work();
          throw new Error("Nested transaction");
        }
        source.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
        owner.transaction = true;
        try {
          const result = await work();
          source.exec("COMMIT");
          return result;
        } catch (error) {
          source.exec("ROLLBACK");
          throw error;
        } finally {
          owner.transaction = false;
        }
      }),
    close: async () =>
      await exclusive(async () => {
        source.close();
      }),
  };
  connections.set(source, database);
  return database;
}

export async function openPostgresDatabase(
  archiveId: string,
  file: string,
): Promise<StoreDatabase> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$/.test(archiveId))
    throw new Error("Некорректный идентификатор архива PostgreSQL");
  const pool = new pg.Pool({
    // Root + four scoped runtimes use at most ten slots per process by default.
    // Two processes leave room within production's 27 ordinary PG connections.
    max: postgresPoolSize(),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    application_name: "drevo",
    options: `-c drevo.archive_id=${archiveId} -c timezone=UTC`,
    types: {
      getTypeParser(oid, format) {
        // The existing stores parse their JSON explicitly. Do not alter pg's
        // global parsers used by migration and verification tools.
        if (oid === 114 || oid === 3802) return (value: string) => value;
        if (oid === 20)
          return (value: string) => {
            const number = Number(value);
            if (!Number.isSafeInteger(number))
              throw new Error("Число БД вне безопасного диапазона");
            return number;
          };
        return pg.types.getTypeParser(oid, format);
      },
    },
  });
  pool.on("error", () => console.error("postgres_idle_connection_failed"));
  const context = new AsyncLocalStorage<{
    client: pg.PoolClient;
    active: boolean;
  }>();
  // Long tasks own a session, not a transaction. SQL and short transactions
  // borrow that same connection, including nested filesystem locks. Serialize
  // independent operations so they cannot enter another callback's transaction.
  type TaskSession = {
    client: pg.PoolClient;
    tail: Promise<void>;
    discard: boolean;
  };
  const tasks = new AsyncLocalStorage<{
    session: TaskSession;
    active: boolean;
  }>();
  // Task waiters consume no pool clients. Keep one slot available to ordinary
  // requests even when filesystem callbacks hold advisory locks for minutes.
  const taskLimit = pool.options.max! - 1;
  let taskOwners = 0;
  const taskWaiters: Array<() => void> = [];
  function taskSlotRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const grant = taskWaiters.shift();
      if (grant) grant();
      else taskOwners--;
    };
  }
  async function reserveTaskSlot(): Promise<() => void> {
    if (taskOwners < taskLimit) {
      taskOwners++;
      return taskSlotRelease();
    }
    return await new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timeout);
        resolve(taskSlotRelease());
      };
      const timeout = setTimeout(() => {
        const index = taskWaiters.indexOf(grant);
        if (index >= 0) taskWaiters.splice(index, 1);
        reject(new Error("Background task connection budget is busy"));
      }, 5000);
      taskWaiters.push(grant);
    });
  }
  async function onTaskSession<T>(
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const task = tasks.getStore();
    if (!task?.active)
      throw new Error("Контекст фоновой задачи БД уже завершён");
    const previous = task.session.tail;
    let release!: () => void;
    task.session.tail = new Promise<void>((done) => {
      release = done;
    });
    await previous;
    try {
      if (!task.active || task.session.discard)
        throw new Error("Контекст фоновой задачи БД уже завершён");
      return await work(task.session.client);
    } finally {
      release();
    }
  }
  const query = (sql: string, values?: SQLInputValue[]) => {
    const owner = context.getStore();
    if (owner && !owner.active)
      throw new Error("Контекст транзакции БД уже завершён");
    if (owner) return owner.client.query<Row>(sql, values);
    if (tasks.getStore())
      return onTaskSession((client) => client.query<Row>(sql, values));
    return pool.query<Row>(sql, values);
  };
  async function withSessionTaskLock<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    if (context.getStore())
      throw new Error("Task lock cannot run inside a transaction");
    const parent = tasks.getStore();
    if (parent && !parent.active)
      throw new Error("Контекст фоновой задачи БД уже завершён");
    let releaseSlot: (() => void) | undefined;
    let borrowed = parent?.session;
    if (!borrowed) {
      releaseSlot = await reserveTaskSlot();
      try {
        borrowed = {
          client: await pool.connect(),
          tail: Promise.resolve(),
          discard: false,
        };
      } catch (error) {
        releaseSlot();
        throw error;
      }
    }
    const session = borrowed;
    const scope = { session, active: true };
    return await tasks.run(scope, async () => {
      let acquired = false;
      let discard = false;
      let failed = false;
      let failure: unknown;
      let value: T | undefined;
      try {
        const result = await onTaskSession((client) =>
          client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
            [key],
          ),
        );
        acquired = !!result.rows[0]?.acquired;
        if (acquired) {
          const job = { session, active: true };
          try {
            value = await tasks.run(job, work);
          } finally {
            job.active = false;
          }
        }
      } catch (error) {
        if (!acquired) discard = true;
        failed = true;
        failure = error;
      }
      try {
        if (acquired) {
          const result = await onTaskSession((client) =>
            client.query<{ released: boolean }>(
              "SELECT pg_advisory_unlock($1::bigint) AS released",
              [key],
            ),
          );
          if (!result.rows[0]?.released) throw new Error("Task lock was lost");
        }
      } catch (error) {
        discard = true;
        failed = true;
        failure = error;
      } finally {
        scope.active = false;
        if (discard) session.discard = true;
        if (!parent) {
          await session.tail;
          try {
            session.client.release(session.discard);
          } finally {
            releaseSlot?.();
          }
        }
      }
      if (failed) throw failure;
      return acquired
        ? { acquired: true, value: value as T }
        : { acquired: false };
    });
  }
  const database: StoreDatabase = {
    kind: "postgres",
    poolDiagnostics: () => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      limit: pool.options.max!,
    }),
    archiveId,
    file,
    inTransaction: () => !!context.getStore(),
    prepare(sqlite, postgres) {
      if (!postgres)
        throw new Error("Для PostgreSQL не задан явный SQL-запрос");
      const sql = postgresBindings(postgres);
      return {
        get: async (...values) => (await query(sql, values)).rows[0],
        all: async (...values) => (await query(sql, values)).rows,
        run: async (...values) => {
          const result = await query(sql, values);
          return {
            changes: result.rowCount || 0,
            lastInsertRowid: Number(result.rows[0]?.id || 0),
          };
        },
      };
    },
    exec: async (_sqlite, postgres) => {
      if (!postgres)
        throw new Error("Для PostgreSQL не задан явный SQL-запрос");
      await query(postgres);
    },
    async transaction(work, readOnly = false) {
      const parent = context.getStore();
      if (parent) {
        if (!parent.active)
          throw new Error("Контекст транзакции БД уже завершён");
        if (readOnly) return await work();
        throw new Error("Вложенная транзакция не поддерживается");
      }
      const execute = async (client: pg.PoolClient) => {
        const owner = { client, active: true };
        try {
          await client.query(
            readOnly
              ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
              : "BEGIN",
          );
          await client.query("SET LOCAL lock_timeout='5s'");
          if (!readOnly)
            await client.query(
              "SELECT set_config('drevo.parent_evidence_write','on',true)",
            );
          if (!readOnly)
            await client.query(
              "SELECT id FROM archives WHERE id=$1 FOR UPDATE",
              [archiveId],
            );
          const result = await context.run(owner, work);
          owner.active = false;
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          owner.active = false;
        }
      };
      if (tasks.getStore()) return await onTaskSession(execute);
      const client = await pool.connect();
      try {
        return await execute(client);
      } finally {
        client.release();
      }
    },
    async postgresTransaction(work) {
      if (context.getStore())
        throw new Error("Вложенная транзакция не поддерживается");
      const task = tasks.getStore();
      const execute = async (client: pg.PoolClient) => {
        const owner = { client, active: true };
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL lock_timeout='5s'");
          // Explicit permission transactions outside a task intentionally own
          // only their callback's raw client. Their work can start an independent
          // file task; publishing that transaction as archive context would
          // forbid the existing permission -> file-task execution path.
          const result = task
            ? await context.run(owner, () => work(client))
            : await work(client);
          owner.active = false;
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          owner.active = false;
        }
      };
      if (task) return await onTaskSession(execute);
      const client = await pool.connect();
      try {
        return await execute(client);
      } finally {
        client.release();
      }
    },
    async withExclusiveArchiveTask(task, work) {
      if (!/^[a-z0-9-]{1,64}$/.test(task))
        throw new Error("Invalid archive task name");
      const lockKey = createHash("sha256")
        .update(`${archiveId}:${task}`)
        .digest()
        .readBigInt64BE(0)
        .toString();
      return withSessionTaskLock(lockKey, work);
    },
    async withExclusivePlatformTask(task, work) {
      if (!/^[a-z0-9-]{1,64}$/.test(task))
        throw new Error("Invalid platform task name");
      if (context.getStore())
        throw new Error("Platform file task cannot run inside a transaction");
      const lockKey = createHash("sha256")
        .update(`platform:${task}`)
        .digest()
        .readBigInt64BE(0)
        .toString();
      const deadline = Date.now() + 15_000;
      while (true) {
        // Waiters release their pool connections between attempts: the lock
        // holder still needs a connection for the short disk reservation query.
        const result = await withSessionTaskLock(lockKey, work);
        if (result.acquired) return result.value;
        if (Date.now() >= deadline)
          throw new Error("Platform task lock is busy");
        await delay(50);
      }
    },
    close: () => pool.end(),
  };
  try {
    const role = await pool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls)
      throw new Error(
        "Рабочая роль PostgreSQL не должна обходить RLS или иметь права superuser",
      );
    const result = await pool.query("SELECT id FROM archives WHERE id=$1", [
      archiveId,
    ]);
    if (result.rowCount !== 1) throw new Error("Архив PostgreSQL не найден");
    await initializePostgresRuntimeSchema(database);
    return database;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
