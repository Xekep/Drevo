import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runUnitTests } from "../ops/run-unit-tests.ts";

async function fixture(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "drevo unit runner-"));
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const pass = 'import test from "node:test"; test("passes", () => {});';

test("suite queue bounds real child processes and runs every file once, including paths with spaces", async () => {
  await fixture(async (directory) => {
    const files = [];
    for (let i = 0; i < 4; i++) {
      const file = join(directory, `suite ${i}.test.ts`);
      await writeFile(
        file,
        `import test from "node:test";
        import {appendFileSync,readFileSync} from "node:fs";
        import {setTimeout as delay} from "node:timers/promises";
        test("real isolated process", async () => {
          const file=process.env.RUNNER_EVENTS;
          appendFileSync(file,JSON.stringify({type:"start",id:${i},pid:process.pid})+"\\n");
          if(${i}<2){
            const until=Date.now()+3000;
            while(readFileSync(file,"utf8").trim().split("\\n").filter(x=>JSON.parse(x).type==="start").length<2){
              if(Date.now()>until)throw Error("second process never started");
              await delay(10);
            }
          }
          await delay(50);
          appendFileSync(file,JSON.stringify({type:"end",id:${i},pid:process.pid})+"\\n");
        });`,
      );
      files.push(file);
    }
    const events = join(directory, "events.jsonl");
    const report = await runUnitTests({
      files,
      concurrency: 2,
      reportPath: join(directory, "report.json"),
      env: { RUNNER_EVENTS: events },
    });
    assert.equal(report.successful, true);
    assert.equal(report.completed, 4);
    assert.equal(report.totals.pass, 4);
    const records = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { type: string; id: number; pid: number },
      );
    let active = 0,
      maximum = 0;
    for (const event of records) {
      active += event.type === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
      assert.ok(active >= 0 && active <= 2);
    }
    assert.equal(maximum, 2);
    assert.equal(active, 0);
    assert.equal(
      new Set(
        records
          .filter((event) => event.type === "start")
          .map((event) => event.pid),
      ).size,
      4,
    );
  });
});

test("a failed suite stays failed while the rest finish, with complete separate logs", async () => {
  await fixture(async (directory) => {
    const failed = join(directory, "failed.test.ts"),
      passed = join(directory, "passed.test.ts");
    await writeFile(
      failed,
      'import test from "node:test"; test("failure", () => {console.log("x".repeat(100000));throw Error("original failure");});',
    );
    await writeFile(passed, pass);
    const report = await runUnitTests({
      files: [failed, passed],
      concurrency: 2,
      reportPath: join(directory, "report.json"),
    });
    assert.equal(report.successful, false);
    assert.equal(report.completed, 2);
    assert.equal(report.totals.fail, 1);
    assert.equal(report.totals.pass, 1);
    const suite = report.suites.find((result) => !result.passed)!;
    const log = await readFile(join(directory, suite.log), "utf8");
    assert.ok(log.includes("x".repeat(100000)));
    assert.match(log, /original failure/);
  });
});

test("a successful process without node:test results cannot make the run green", async () => {
  await fixture(async (directory) => {
    const file = join(directory, "empty.test.ts");
    await writeFile(file, "console.log('not a test');");
    const report = await runUnitTests({
      files: [file],
      concurrency: 1,
      reportPath: join(directory, "report.json"),
    });
    assert.equal(report.successful, false);
    assert.match(report.suites[0].error!, /Missing node:test summary/);
  });
});

test("timeout terminates a stalled suite and leaves the next suite runnable", async () => {
  await fixture(async (directory) => {
    const stuck = join(directory, "stuck.test.ts"),
      passed = join(directory, "passed.test.ts");
    await writeFile(
      stuck,
      'import test from "node:test"; test("never finishes", async () => {setInterval(()=>{},1000);await new Promise(()=>{});});',
    );
    await writeFile(passed, pass);
    const report = await runUnitTests({
      files: [stuck, passed],
      concurrency: 1,
      timeoutMs: 1500,
      reportPath: join(directory, "report.json"),
    });
    assert.equal(report.successful, false);
    assert.equal(
      report.suites.find((result) => result.file.endsWith("stuck.test.ts"))
        ?.timedOut,
      true,
    );
    assert.equal(
      report.suites.find((result) => result.file.endsWith("passed.test.ts"))
        ?.passed,
      true,
    );
  });
});

test("cancellation kills active processes, stops the queue and reports unrun files", async () => {
  await fixture(async (directory) => {
    const stuck = join(directory, "stuck.test.ts"),
      passed = join(directory, "passed.test.ts");
    const ready = join(directory, "ready");
    await writeFile(
      stuck,
      'import test from "node:test";import {writeFileSync} from "node:fs";test("wait", async()=>{writeFileSync(process.env.RUNNER_READY,"ready");setInterval(()=>{},1000);await new Promise(()=>{});});',
    );
    await writeFile(passed, pass);
    const controller = new AbortController();
    const pending = runUnitTests({
      files: [stuck, passed],
      concurrency: 1,
      signal: controller.signal,
      reportPath: join(directory, "report.json"),
      env: { RUNNER_READY: ready },
    });
    const until = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (Date.now() > until) {
        controller.abort();
        throw new Error("fixture did not start");
      }
      await delay(10);
    }
    controller.abort();
    const report = await pending;
    assert.equal(report.successful, false);
    assert.equal(report.interrupted, true);
    assert.equal(report.completed, 1);
    assert.equal(report.notRun.length, 1);
    assert.ok(report.notRun[0].endsWith("passed.test.ts"));
  });
});
