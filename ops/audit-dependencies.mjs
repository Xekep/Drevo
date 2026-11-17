import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hasPatchedPicomatch } from "./patch-picomatch.mjs";

const advisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const packagePath = "node_modules/picomatch";
const { packages } = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const audit = spawnSync(process.execPath, [process.env.npm_execpath, "audit", "--audit-level=high", "--json"], {
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
if (audit.error) throw audit.error;
if (audit.stderr) process.stderr.write(audit.stderr);
const report = JSON.parse(audit.stdout);
if (audit.signal || ![0, 1].includes(audit.status) || report.error || !report.vulnerabilities ||
    !Number.isInteger(report.metadata?.vulnerabilities?.high) ||
    !Number.isInteger(report.metadata?.vulnerabilities?.critical))
  throw new Error("npm audit did not return a complete advisory report");

const high = Object.values(report.vulnerabilities).filter(item =>
  item.severity === "high" || item.severity === "critical");
console.log(JSON.stringify(report, null, 2));

// Accept only the pinned, patched dev package and advisories propagated from it.
// Keep failing on every independent high/critical advisory, malformed graph, or
// moved copy. The server runtime lockfile is audited separately without exceptions.
function covered(item, visited = new Set()) {
  if (!item || visited.has(item.name) || !item.nodes?.length ||
      !item.nodes.every(node => packages[node]?.dev === true) || !item.via?.length)
    return false;
  if (item.name === "picomatch")
    return item.nodes.length === 1 && item.nodes[0] === packagePath &&
      item.via.every(cause => cause?.dependency === "picomatch" && cause.url === advisory);
  const next = new Set(visited).add(item.name);
  return item.via.every(cause => typeof cause === "string" && covered(report.vulnerabilities[cause], next));
}

if (high.length === 0) {
  process.exitCode = audit.status;
} else if (high.length !== report.metadata.vulnerabilities.high + report.metadata.vulnerabilities.critical ||
    report.metadata.vulnerabilities.critical !== 0 || packages[packagePath]?.version !== "4.0.7" ||
    !hasPatchedPicomatch() || !high.every(item => covered(item))) {
  process.exitCode = 1;
} else {
  console.log("GHSA-fc5q-39xc-vjpf: verified patch on picomatch 4.0.7, development only.");
}
