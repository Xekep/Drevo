import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eFamily } from "./e2e/base-family.ts";
import { startServer } from "../src/server/index.ts";
import { seedTreeAcceptanceFixture } from "./e2e/tree-acceptance-fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "drevo-e2e-"));
const port = Number(process.env.DREVO_E2E_PORT || 4173);
const app = await startServer(port, join(directory, "drevo.sqlite"), true);
const current = await app.archive.read();
if (process.env.DREVO_TREE_ACCEPTANCE === "1")
  await seedTreeAcceptanceFixture(app.archive, directory);
else
  await app.archive.write(
    e2eFamily(current.family),
    current.revision,
  );
let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
}

process.on("uncaughtException", (error) => {
  console.error(error);
  void close().then(() => process.exit(1));
});
