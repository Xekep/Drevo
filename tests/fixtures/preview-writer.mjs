import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";

const [directory, sourcePath, simulateExisting] = process.argv.slice(2);
const realRename = fsPromises.rename;
let publish;
const canPublish = new Promise((resolve) => { publish = resolve; });
fsPromises.rename = async (source, destination) => {
  process.send?.({ stage: "written" });
  await canPublish;
  if (simulateExisting === "yes") {
    const error = new Error("destination already exists");
    error.code = "EEXIST";
    throw error;
  }
  return realRename(source, destination);
};
syncBuiltinESMExports();
const { imagePreviews } = await import("../../src/server/image-previews.ts");

process.on("message", (message) => {
  if (message === "publish") publish();
  if (message === "start") void imagePreviews(directory)(
    { path: sourcePath, cacheKey: "shared-synthetic.png" }, "display",
  ).then((bytes) => {
    process.send?.({ stage: "done", sha256: createHash("sha256").update(bytes).digest("hex") });
  }, (error) => {
    process.send?.({ stage: "failed", error: String(error) });
  });
});
process.send?.({ stage: "ready" });
