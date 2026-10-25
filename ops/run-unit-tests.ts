import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Counts = {
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
};
export type SuiteResult = {
  file: string;
  durationMs: number;
  passed: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  log: string;
  counts: Counts | null;
  error?: string;
};
type Options = {
  files: readonly string[];
  concurrency: number;
  reportPath: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onSuite?: (result: SuiteResult, finished: number) => void;
};

function countsFromTap(log: string): Counts | null {
  const counts: Partial<Counts> = {};
  for (const match of log.matchAll(
    /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm,
  ))
    counts[match[1] as keyof Counts] = Number(match[2]);
  const keys = [
    "tests",
    "pass",
    "fail",
    "cancelled",
    "skipped",
    "todo",
  ] as const;
  return keys.every((key) => Number.isSafeInteger(counts[key])) &&
    counts.tests! > 0
    ? (counts as Counts)
    : null;
}

/** Only disposable processes created by this runner are terminated. */
function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    const killed = spawnSync(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { windowsHide: true, stdio: "ignore" },
    );
    if (killed.status !== 0) child.kill("SIGKILL");
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

/** Each suite keeps its own Node process; Node 22's IPC test runner is not used. */
export async function runUnitTests(options: Options) {
  const { concurrency, signal } = options;
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("Test concurrency must be an integer from 1 to 8");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Test timeout must be a positive integer");
  const cwd = resolve(options.cwd ?? process.cwd());
  const files = options.files.map((file) => resolve(cwd, file));
  if (!files.length || new Set(files).size !== files.length)
    throw new Error("Test files must be a nonempty list without duplicates");
  for (const file of files)
    if (!statSync(file).isFile()) throw new Error(`Not a test file: ${file}`);
  const reportPath = resolve(options.reportPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  const logs = mkdtempSync(join(dirname(reportPath), "logs-"));
  const started = performance.now();
  const active = new Set<ChildProcess>();
  const results: SuiteResult[] = [];
  let next = 0;
  let stopping = signal?.aborted ?? false;
  const abort = () => {
    stopping = true;
    for (const child of active) stopChild(child);
  };
  signal?.addEventListener("abort", abort, { once: true });

  const run = (file: string, index: number) =>
    new Promise<SuiteResult>((done, reject) => {
      const log = join(
        logs,
        `${String(index + 1).padStart(4, "0")}-${basename(file)}.log`,
      );
      const fd = openSync(log, "wx");
      const env = { ...process.env, ...options.env };
      delete env.NODE_TEST_CONTEXT;
      const start = performance.now();
      let child: ChildProcess;
      try {
        child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--test-reporter=tap", file],
          {
            cwd,
            env,
            stdio: ["ignore", fd, fd],
            windowsHide: true,
            detached: process.platform !== "win32",
          },
        );
      } finally {
        closeSync(fd);
      }
      active.add(child);
      let timedOut = false;
      let error: string | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        stopChild(child);
      }, timeoutMs);
      timer.unref();
      child.once("error", (failure) => {
        error = failure.message;
      });
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        active.delete(child);
        try {
          const counts = countsFromTap(readFileSync(log, "utf8"));
          if (!counts && !error && !timedOut && !signal?.aborted)
            error = "Missing node:test summary";
          done({
            file: relative(cwd, file).replaceAll("\\", "/"),
            durationMs: Math.round(performance.now() - start),
            passed:
              code === 0 &&
              !exitSignal &&
              !timedOut &&
              !error &&
              !!counts &&
              counts.fail === 0 &&
              counts.cancelled === 0,
            code,
            signal: exitSignal,
            timedOut,
            log: relative(dirname(reportPath), log).replaceAll("\\", "/"),
            counts,
            ...(error ? { error } : {}),
          });
        } catch (failure) {
          reject(failure);
        }
      });
    });
  const workers = Array.from(
    { length: Math.min(concurrency, files.length) },
    async () => {
      while (!stopping && next < files.length) {
        const index = next++;
        const result = await run(files[index], index);
        results.push(result);
        options.onSuite?.(result, results.length);
      }
    },
  );
  try {
    await Promise.all(workers);
  } catch (failure) {
    abort();
    await Promise.allSettled(workers);
    throw failure;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const totals: Counts = {
    tests: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  for (const suite of results)
    if (suite.counts)
      for (const key of Object.keys(totals) as (keyof Counts)[])
        totals[key] += suite.counts[key];
  const report = {
    node: process.version,
    platform: process.platform,
    concurrency,
    timeoutMs,
    durationMs: Math.round(performance.now() - started),
    successful:
      !signal?.aborted &&
      results.length === files.length &&
      results.every((suite) => suite.passed),
    interrupted: signal?.aborted ?? false,
    selected: files.length,
    completed: results.length,
    selectedFiles: files.map((file) =>
      relative(cwd, file).replaceAll("\\", "/"),
    ),
    notRun: files
      .slice(next)
      .map((file) => relative(cwd, file).replaceAll("\\", "/")),
    totals,
    suites: results.sort((a, b) => a.file.localeCompare(b.file)),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  return report;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let concurrency = Number(
    process.env.DREVO_TEST_CONCURRENCY ?? Math.min(2, availableParallelism()),
  );
  let timeoutMs = 300_000;
  let reportPath = join(
    root,
    "outputs",
    "unit-tests",
    `${Date.now()}-${process.pid}`,
    "report.json",
  );
  let seed: number | undefined;
  let files: string[] = [];
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith("--concurrency="))
      concurrency = Number(argument.slice(14));
    else if (argument.startsWith("--timeout-ms="))
      timeoutMs = Number(argument.slice(13));
    else if (argument.startsWith("--report="))
      reportPath = resolve(argument.slice(9));
    else if (argument.startsWith("--seed=")) seed = Number(argument.slice(7));
    else if (argument.startsWith("-"))
      throw new Error(`Unknown test option: ${argument}`);
    else files.push(resolve(argument));
  }
  if (!files.length)
    files = readdirSync(join(root, "tests"))
      .filter((file) => file.endsWith(".test.ts"))
      .sort()
      .map((file) => join(root, "tests", file));
  if (seed !== undefined) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new Error("Seed must be a uint32");
    let state = seed;
    for (let i = files.length - 1; i > 0; i--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = Math.floor((state / 0x100000000) * (i + 1));
      [files[i], files[j]] = [files[j], files[i]];
    }
  }
  const controller = new AbortController();
  let interruptCode = 130;
  const interrupt = (name: NodeJS.Signals) => {
    interruptCode = name === "SIGTERM" ? 143 : 130;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  console.log(
    `Unit suites: ${files.length}; processes: ${concurrency}; Node ${process.version}${seed === undefined ? "" : `; seed: ${seed}`}`,
  );
  try {
    const report = await runUnitTests({
      files,
      concurrency,
      cwd: root,
      reportPath,
      timeoutMs,
      signal: controller.signal,
      onSuite(suite, finished) {
        console.log(
          `[${finished}/${files.length}] ${suite.passed ? "PASS" : "FAIL"} ${suite.file} ${(suite.durationMs / 1000).toFixed(2)}s`,
        );
        if (!suite.passed) {
          console.error(
            readFileSync(join(dirname(reportPath), suite.log), "utf8").slice(
              -32_768,
            ),
          );
          if (suite.error || suite.timedOut)
            console.error(suite.error ?? `Suite exceeded ${timeoutMs}ms`);
        }
      },
    });
    console.log(
      `Suites: ${report.completed}/${report.selected}; failed suites: ${report.suites.filter((suite) => !suite.passed).length}; passed tests: ${report.totals.pass}; failed tests: ${report.totals.fail}; skipped: ${report.totals.skipped}; ${(report.durationMs / 1000).toFixed(2)}s`,
    );
    if (report.interrupted)
      console.error(
        `Interrupted; ${report.notRun.length} suites were not started`,
      );
    for (const suite of [...report.suites]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10))
      console.log(
        `Slow: ${(suite.durationMs / 1000).toFixed(2)}s ${suite.file}`,
      );
    console.log(`Report: ${reportPath}`);
    process.exitCode = report.interrupted
      ? interruptCode
      : report.successful
        ? 0
        : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
