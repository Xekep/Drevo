import pg from "pg";
import { workQueue, WorkQueueBusyError } from "./work-queue.ts";

/** One owner per backend. Archive views borrow connections, never own the pool. */
export function postgresConnections(
  max = Number(process.env.DREVO_PG_PROCESS_POOL_SIZE || 10),
) {
  if (!Number.isInteger(max) || max < 3 || max > 10)
    throw new Error(
      "DREVO_PG_PROCESS_POOL_SIZE должен быть целым числом от 3 до 10",
    );
  const pool = new pg.Pool({
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    application_name: "drevo",
    options: "-c timezone=UTC",
    types: {
      getTypeParser(oid, format) {
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
  let tasks = 0;
  const waiters: Array<() => void> = [];
  const taskLimit = Math.min(3, max - 2);
  // Permission deliveries may retain a transaction while an independent file
  // task needs a second connection. Keep a slot for short standalone SQL too.
  const transactions = workQueue(max - taskLimit - 1, 256, 5000);
  return {
    pool,
    reserveTransaction: () => transactions.acquire(),
    async connect(archiveId: string) {
      const client = await pool.connect().catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === "timeout exceeded when trying to connect"
        )
          throw new WorkQueueBusyError();
        throw error;
      });
      try {
        await client.query("SELECT set_config('drevo.archive_id',$1,false)", [
          archiveId,
        ]);
      } catch (error) {
        client.release(true);
        throw error;
      }
      let released = false;
      return {
        client,
        async release(discard = false) {
          if (released) return;
          released = true;
          // Covers archive/account GUCs, role changes and session advisory locks.
          // A failed reset destroys the socket; no next archive can inherit state.
          if (!discard) {
            try {
              await client.query("DISCARD ALL");
            } catch {
              discard = true;
            }
          }
          client.release(discard);
        },
      };
    },
    async reserveTask() {
      if (tasks >= taskLimit)
        await new Promise<void>((resolve, reject) => {
          const grant = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            const index = waiters.indexOf(grant);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("Background task connection budget is busy"));
          }, 5000);
          waiters.push(grant);
        });
      else tasks++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const grant = waiters.shift();
        if (grant) grant();
        else tasks--;
      };
    },
    close: () => {
      transactions.close();
      return pool.end();
    },
  };
}
export type PostgresConnections = ReturnType<typeof postgresConnections>;
