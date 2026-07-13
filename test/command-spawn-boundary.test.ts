import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceRoot = path.resolve("src");
const directCommandSpawnPattern =
  /\b(spawnSync|execFileSync)\s*\(\s*(?:"(git|gh)"|'(git|gh)'|`(git|gh)`)/g;
const directProtectedResolverPattern =
  /\b(resolveCommand)\s*\(\s*(?:"(git|gh)"|'(git|gh)'|`(git|gh)`)/g;

test("production git and gh synchronous spawns use the command resolver", () => {
  const violations: string[] = [];

  for (const file of productionTypeScriptFiles(sourceRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(directCommandSpawnPattern)) {
      const command = match[2] ?? match[3] ?? match[4] ?? "unknown";
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(
        `${path.relative(process.cwd(), file)}:${line} ${match[1]}(${JSON.stringify(command)})`,
      );
    }
    for (const match of source.matchAll(directProtectedResolverPattern)) {
      const command = match[2] ?? match[3] ?? match[4] ?? "unknown";
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(
        `${path.relative(process.cwd(), file)}:${line} ${match[1]}(${JSON.stringify(command)})`,
      );
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      "Direct git/gh child-process calls bypass src/command.ts.",
      "Use resolveSpawnCommand or a wrapper that delegates to it so Windows launcher handling is preserved:",
      ...violations.map((violation) => `- ${violation}`),
    ].join("\n"),
  );
});

function productionTypeScriptFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return productionTypeScriptFiles(file);
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        return [];
      }
      return [file];
    })
    .sort();
}
