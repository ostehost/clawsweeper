#!/usr/bin/env node
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const DEFAULT_GENERATED_PATHS = [
  "records",
  "jobs",
  "results",
  "assets",
  "notifications",
  "apply-report.json",
  "repair-apply-report.json",
];
const APPROVED_GENERATED_PATHS = new Set([...DEFAULT_GENERATED_PATHS, "ledger"]);

type Args = {
  hydratePaths?: string;
  stateDir?: string;
  worktree?: string;
};

const args = parseArgs(process.argv.slice(2));
const stateRoot = prepareRoot(
  args.stateDir ?? process.env.CLAWSWEEPER_STATE_DIR ?? "../clawsweeper-state",
  "state directory",
);
const worktreeRoot = prepareRoot(args.worktree ?? process.cwd(), "worktree");
const generatedPaths = selectedGeneratedPaths(
  args.hydratePaths ?? process.env.CLAWSWEEPER_HYDRATE_PATHS,
);
const sourcePaths = new Map<string, string>();
const destinationPaths = new Map<string, string>();
const presentSources = new Set<string>();

for (const relativePath of generatedPaths) {
  const source = descendantPath(stateRoot, relativePath, "source");
  const destination = descendantPath(worktreeRoot, relativePath, "destination");
  assertDisjoint(stateRoot.path, destination, relativePath);
  sourcePaths.set(relativePath, source);
  destinationPaths.set(relativePath, destination);
  if (validateTree(source, stateRoot, `state ${relativePath}`)) {
    presentSources.add(relativePath);
  }
  validateTree(destination, worktreeRoot, `worktree ${relativePath}`);
}

if (presentSources.size === 0) {
  throw new Error(
    `State directory has no generated paths: ${stateRoot.path}. Check out the generated state branch first, for example: git -C ${stateRoot.path} switch state`,
  );
}

const stagingRoot = mkdtempSync(path.join(worktreeRoot.path, ".clawsweeper-hydrate-"));
try {
  for (const relativePath of presentSources) {
    const source = requiredMapValue(sourcePaths, relativePath);
    const staged = path.join(stagingRoot, relativePath);
    mkdirSync(path.dirname(staged), { recursive: true });
    copyValidatedTree(source, staged, stateRoot, `state ${relativePath}`);
  }

  for (const relativePath of generatedPaths) {
    assertStableRoot(stateRoot);
    assertStableRoot(worktreeRoot);
    const destination = requiredMapValue(destinationPaths, relativePath);
    validateTree(destination, worktreeRoot, `worktree ${relativePath}`);
    rmSync(destination, { force: true, recursive: true });
    if (!presentSources.has(relativePath)) continue;
    renameSync(path.join(stagingRoot, relativePath), destination);
  }
} finally {
  rmSync(stagingRoot, { force: true, recursive: true });
}

console.log(
  JSON.stringify({
    hydrated: generatedPaths,
    source: stateRoot.path,
    target: worktreeRoot.path,
  }),
);

type SafeRoot = {
  dev: bigint;
  ino: bigint;
  path: string;
};

function prepareRoot(input: string, label: string): SafeRoot {
  const resolved = path.resolve(input);
  let resolvedStat;
  try {
    resolvedStat = lstatSync(resolved, { bigint: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`${capitalize(label)} does not exist: ${resolved}`);
    }
    throw error;
  }
  if (resolvedStat.isSymbolicLink() || !resolvedStat.isDirectory()) {
    throw new Error(`${capitalize(label)} is not a real directory: ${resolved}`);
  }
  let realPath: string;
  try {
    realPath = realpathSync.native(resolved);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`${capitalize(label)} does not exist: ${resolved}`);
    }
    throw error;
  }
  const stat = lstatSync(realPath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${capitalize(label)} is not a real directory: ${resolved}`);
  }
  if (stat.dev !== resolvedStat.dev || stat.ino !== resolvedStat.ino) {
    throw new Error(`${capitalize(label)} changed while resolving: ${resolved}`);
  }
  return { dev: stat.dev, ino: stat.ino, path: realPath };
}

function assertStableRoot(root: SafeRoot): void {
  const stat = lstatSync(root.path, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== root.dev ||
    stat.ino !== root.ino ||
    realpathSync.native(root.path) !== root.path
  ) {
    throw new Error(`Hydration root changed during operation: ${root.path}`);
  }
}

function descendantPath(root: SafeRoot, relativePath: string, label: string): string {
  const candidate = path.resolve(root.path, relativePath);
  const relative = path.relative(root.path, candidate);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Unsafe generated hydration ${label}: ${JSON.stringify(relativePath)}`);
  }
  return candidate;
}

function validateTree(candidate: string, root: SafeRoot, label: string): boolean {
  assertStableRoot(root);
  const initial = optionalLstat(candidate);
  if (!initial) return false;

  const pending = [candidate];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in ${label}: ${current}`);
    }
    assertRealPathInsideRoot(current, root, label);
    if (stat.isFile()) continue;
    if (!stat.isDirectory()) {
      throw new Error(`Refusing non-file or directory in ${label}: ${current}`);
    }
    for (const entry of readdirSync(current)) {
      pending.push(path.join(current, entry));
    }
  }
  assertStableRoot(root);
  return true;
}

function copyValidatedTree(
  source: string,
  destination: string,
  root: SafeRoot,
  label: string,
): void {
  cpSync(source, destination, {
    recursive: true,
    filter: (currentSource) => {
      assertStableRoot(root);
      const stat = lstatSync(currentSource);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link in ${label}: ${currentSource}`);
      }
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new Error(`Refusing non-file or directory in ${label}: ${currentSource}`);
      }
      assertRealPathInsideRoot(currentSource, root, label);
      return true;
    },
  });
}

function assertRealPathInsideRoot(candidate: string, root: SafeRoot, label: string): void {
  const real = realpathSync.native(candidate);
  const relative = path.relative(root.path, real);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Refusing ${label} outside hydration root: ${candidate}`);
  }
}

function assertDisjoint(source: string, destination: string, relativePath: string): void {
  if (isSameOrDescendant(source, destination) || isSameOrDescendant(destination, source)) {
    throw new Error(`Refusing overlapping hydration paths for ${relativePath}`);
  }
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    !relative ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function optionalLstat(candidate: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(candidate);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function requiredMapValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing hydration path for ${key}`);
  return value;
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--state-dir") parsed.stateDir = requiredValue(argv, ++index, arg);
    else if (arg === "--worktree") parsed.worktree = requiredValue(argv, ++index, arg);
    else if (arg === "--hydrate-paths") parsed.hydratePaths = requiredValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function selectedGeneratedPaths(input: string | undefined): string[] {
  if (!input?.trim()) return [...DEFAULT_GENERATED_PATHS];

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of input.split(/\r?\n/)) {
    const candidate = rawPath.trim();
    if (!candidate) continue;
    validateGeneratedPath(candidate);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      selected.push(candidate);
    }
  }
  return selected;
}

function validateGeneratedPath(candidate: string): void {
  if (
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    [...candidate].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(`Unsafe generated hydration path: ${JSON.stringify(candidate)}`);
  }

  const normalized = candidate.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized !== candidate ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    segments.some((segment) => segment.startsWith("."))
  ) {
    throw new Error(`Unsafe generated hydration path: ${JSON.stringify(candidate)}`);
  }
  if (!APPROVED_GENERATED_PATHS.has(candidate)) {
    throw new Error(`Unknown generated hydration root: ${JSON.stringify(candidate)}`);
  }
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
