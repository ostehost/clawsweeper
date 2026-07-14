import { runCommand as run } from "./command-runner.js";

const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;

export function exactCommitRefspec({
  commit,
  targetRef,
}: {
  commit: string;
  targetRef: string;
}): string {
  if (!GIT_OBJECT_ID.test(commit)) {
    throw new Error("reviewed publication commit is missing or malformed");
  }
  if (!isValidHeadRef(targetRef)) {
    throw new Error("reviewed publication target ref is missing or malformed");
  }
  return `${commit}:${targetRef}`;
}

function isValidHeadRef(targetRef: string): boolean {
  if (!targetRef.startsWith("refs/heads/")) return false;
  const branch = targetRef.slice("refs/heads/".length);
  if (
    !branch ||
    branch === "@" ||
    [...branch].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    }) ||
    /[~^:?*\\[]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".")
  ) {
    return false;
  }
  return branch
    .split("/")
    .every((component) => component && !component.startsWith(".") && !component.endsWith(".lock"));
}

export function commitTreeSha({
  targetDir,
  commit,
}: {
  targetDir: string;
  commit: string;
}): string {
  if (!GIT_OBJECT_ID.test(commit)) {
    throw new Error("reviewed publication commit is missing or malformed");
  }
  return run("git", ["-c", "core.fsmonitor=false", "rev-parse", `${commit}^{tree}`], {
    cwd: targetDir,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

export function assertCommitTree({
  targetDir,
  commit,
  expectedTree,
}: {
  targetDir: string;
  commit: string;
  expectedTree: string;
}): void {
  if (!GIT_OBJECT_ID.test(expectedTree) || commitTreeSha({ targetDir, commit }) !== expectedTree) {
    throw new Error("publication commit does not match the reviewed tree");
  }
}
