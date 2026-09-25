import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)
        ? [join(directory, entry.name)]
        : [],
  );
}
const files = sourceFiles(join(root, "src")),
  known = new Set(files);
const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  root,
).options;
const name = (path: string) => relative(root, path).replaceAll("\\", "/");
type Dependency = { source: string; target?: string; runtime: boolean };
const graph = new Map<string, Dependency[]>();
for (const path of files) {
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const dependencies: Dependency[] = [];
  function add(source: string, runtime: boolean) {
    const target = ts.resolveModuleName(source, path, options, ts.sys)
      .resolvedModule?.resolvedFileName;
    dependencies.push({
      source,
      runtime,
      target:
        target && known.has(resolve(target)) ? resolve(target) : undefined,
    });
  }
  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause,
        named = clause?.namedBindings;
      const onlyTypes =
        clause?.isTypeOnly ||
        (!clause?.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((item) => item.isTypeOnly));
      add(node.moduleSpecifier.text, !onlyTypes);
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const named = node.exportClause;
      const onlyTypes =
        node.isTypeOnly ||
        (named &&
          ts.isNamedExports(named) &&
          named.elements.length > 0 &&
          named.elements.every((item) => item.isTypeOnly));
      add(node.moduleSpecifier.text, !onlyTypes);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text, true);
    ts.forEachChild(node, visit);
  }
  visit(file);
  graph.set(path, dependencies);
}

test("domain and shared contracts stay independent of UI, HTTP and persistence", () => {
  const violations: string[] = [];
  for (const [path, dependencies] of graph) {
    const source = name(path);
    if (!/^src\/(domain|shared)\//.test(source)) continue;
    for (const dep of dependencies) {
      if (
        (dep.target && !/^src\/(domain|shared)\//.test(name(dep.target))) ||
        /^(node:|react(?:-dom)?(?:\/|$)|@xyflow\/)/.test(dep.source)
      )
        violations.push(source + " → " + dep.source);
    }
  }
  assert.deepEqual(violations, []);
});

test("server and browser communicate through contracts, not each other's implementation", () => {
  const violations: string[] = [];
  for (const [path, dependencies] of graph) {
    const source = name(path),
      server = source.startsWith("src/server/");
    for (const dep of dependencies) {
      if (
        !server &&
        ((dep.target && name(dep.target).startsWith("src/server/")) ||
          dep.source.startsWith("node:"))
      )
        violations.push(source + " → " + dep.source);
      if (
        server &&
        dep.target &&
        !/^src\/(server|domain|shared)\//.test(name(dep.target))
      )
        violations.push(source + " → " + dep.source);
    }
  }
  assert.deepEqual(violations, []);
});

test("runtime composition has no import cycles, including reexports and lazy imports", () => {
  const done = new Set<string>(),
    active = new Set<string>(),
    stack: string[] = [],
    cycles: string[] = [];
  function visit(path: string) {
    if (active.has(path)) {
      cycles.push(
        [...stack.slice(stack.indexOf(path)), path].map(name).join(" → "),
      );
      return;
    }
    if (done.has(path)) return;
    active.add(path);
    stack.push(path);
    for (const dep of graph.get(path) || [])
      if (dep.runtime && dep.target) visit(dep.target);
    stack.pop();
    active.delete(path);
    done.add(path);
  }
  for (const path of files) visit(path);
  assert.deepEqual(cycles, []);
});
