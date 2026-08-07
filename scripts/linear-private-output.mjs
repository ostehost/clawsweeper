import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** POSIX mode bits are the privacy boundary for these operator-owned artifacts. */
export function assertPrivateOutputPlatform(platform = process.platform) {
  if (platform === "win32") {
    throw new Error(
      "private Linear output files require POSIX owner-only permissions; Windows is unsupported",
    );
  }
}

function resolvePhysicalPath(path) {
  const tail = [];
  let cursor = resolve(path);
  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        try {
          cursor = realpathSync(cursor);
        } catch {
          throw new Error("private Linear output path contains a dangling symlink");
        }
      }
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
  return join(realpathSync(cursor), ...tail);
}

/** Allows external operator paths, but requires repository-local private data to be ignored. */
export function assertSafeOutputPath(path) {
  const requestedPath = resolve(path);
  try {
    if (lstatSync(requestedPath).isSymbolicLink()) {
      throw new Error("private Linear output path must not be a symlink");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  const repoRoot = realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
  );
  const absolutePath = resolvePhysicalPath(path);
  const relativePath = relative(repoRoot, absolutePath);
  const outsideRepository =
    relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
  if (!outsideRepository) {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", relativePath], {
        cwd: repoRoot,
        stdio: "ignore",
      });
    } catch {
      throw new Error("private Linear output inside the repository must be under an ignored path");
    }
  }
  return absolutePath;
}

/** Returns whether the destination exists, rejecting directories, links, and special files. */
export function assertPrivateOutputDestination(path, deps = {}) {
  const lstat = deps.lstatSync ?? lstatSync;
  let stat;
  try {
    stat = lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error("private Linear output destination must be a regular file");
  }
  return true;
}
