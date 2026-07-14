import fs from "node:fs";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";

export type TrustedGitContext = Readonly<{
  argsPrefix: readonly string[];
  env: NodeJS.ProcessEnv;
}>;

const UNSAFE_MUTATION_CONFIG = [
  /^filter\..+\.(?:clean|smudge|process|required)$/i,
  /^diff\..+\.(?:command|textconv)$/i,
  /^merge\..+\.driver$/i,
  /^core\.(?:alternaterefscommand|attributesfile|excludesfile|gitproxy|sshcommand|worktree)$/i,
  /^credential(?:\.|$)/i,
  /^url\..+\.(?:insteadof|pushinsteadof)$/i,
  /^remote\..+\.(?:pushurl|receivepack|uploadpack|proxy|vcs)$/i,
  /^http(?:\.|$)/i,
  /^protocol(?:\.|$)/i,
  /^include(?:if)?\./i,
] as const;

export function fixedGitHubRepositoryUrl(repository: string): string {
  const parts = String(repository ?? "").split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error("trusted Git network operation requires a valid GitHub repository name");
  }
  return `https://github.com/${parts[0]}/${parts[1]}.git`;
}

export function trustedGitContext(trustedRoot: string): TrustedGitContext {
  const controlRoot = prepareTrustedControlRoot(trustedRoot);
  const hooksPath = path.join(controlRoot, "empty-hooks");
  const globalConfigPath = path.join(controlRoot, "empty-global-config");
  fs.mkdirSync(hooksPath, { mode: 0o700 });
  fs.writeFileSync(globalConfigPath, "", { flag: "wx", mode: 0o600 });
  assertTrustedControlPath(controlRoot, hooksPath, "trusted hooks directory");
  assertTrustedControlPath(controlRoot, globalConfigPath, "trusted global config");

  const env = scrubGitMutationEnv(process.env);
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = globalConfigPath;
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_EDITOR = "true";
  env.GIT_SEQUENCE_EDITOR = "true";

  return Object.freeze({
    argsPrefix: Object.freeze([
      "-c",
      `core.hooksPath=${hooksPath}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "push.gpgSign=false",
      "-c",
      "credential.helper=",
      "-c",
      "fetch.recurseSubmodules=false",
      "-c",
      "submodule.recurse=false",
    ]),
    env,
  });
}

export function trustedGitNetworkContext(trustedRoot: string, token: string): TrustedGitContext {
  if (!token.trim()) throw new Error("trusted Git publication requires a GitHub token");
  const context = trustedGitContext(trustedRoot);
  const controlRoot = path.dirname(String(context.env.GIT_CONFIG_GLOBAL ?? ""));
  const askPassPath = ensureTrustedAskPass(controlRoot);
  return {
    argsPrefix: context.argsPrefix,
    env: {
      ...context.env,
      CLAWSWEEPER_TRUSTED_GIT_TOKEN: token,
      GIT_ASKPASS: askPassPath,
      GIT_ASKPASS_REQUIRE: "force",
    },
  };
}

export function assertNoUnsafeGitMutationConfig({
  targetDir,
  trustedRoot,
}: {
  targetDir: string;
  trustedRoot: string;
}): void {
  assertTrustedRootOutsideTarget(targetDir, trustedRoot);
  const context = trustedGitContext(trustedRoot);
  const outputs = [
    run(
      "git",
      [...context.argsPrefix, "config", "--local", "--includes", "--name-only", "-z", "--list"],
      { cwd: targetDir, env: context.env },
    ),
  ];
  const worktreeConfigOutput = run(
    "git",
    [...context.argsPrefix, "rev-parse", "--path-format=absolute", "--git-path", "config.worktree"],
    { cwd: targetDir, env: context.env },
  ).trim();
  const worktreeConfigPath = path.isAbsolute(worktreeConfigOutput)
    ? worktreeConfigOutput
    : path.resolve(targetDir, worktreeConfigOutput);
  if (fs.existsSync(worktreeConfigPath)) {
    outputs.push(
      run(
        "git",
        [
          ...context.argsPrefix,
          "config",
          "--file",
          worktreeConfigPath,
          "--includes",
          "--name-only",
          "-z",
          "--list",
        ],
        { cwd: targetDir, env: context.env },
      ),
    );
  }
  const unsafe = outputs
    .join("\0")
    .split("\0")
    .map((key) => key.trim())
    .filter(Boolean)
    .filter((key) => UNSAFE_MUTATION_CONFIG.some((pattern) => pattern.test(key)));
  if (unsafe.length > 0) {
    throw new Error(`unsafe target Git mutation config: ${[...new Set(unsafe)].join(", ")}`);
  }
}

export function trustedGitArgs(context: TrustedGitContext, args: string[]): string[] {
  return [...context.argsPrefix, ...args];
}

function scrubGitMutationEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      /^(?:GH_|GITHUB_)/i.test(key) ||
      /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i.test(key) ||
      /^GIT_/i.test(key) ||
      /^SSH_ASKPASS$/i.test(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function assertTrustedRootOutsideTarget(targetDir: string, trustedRoot: string) {
  const target = fs.realpathSync(targetDir);
  const trusted = fs.realpathSync(trustedRoot);
  const relative = path.relative(target, trusted);
  if (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    throw new Error("trusted Git control root must be outside the target checkout");
  }
}

function prepareTrustedControlRoot(trustedRoot: string): string {
  const canonicalTrustedRoot = fs.realpathSync(trustedRoot);
  const controlRoot = path.join(canonicalTrustedRoot, "trusted-git");
  fs.rmSync(controlRoot, { recursive: true, force: true });
  fs.mkdirSync(controlRoot, { mode: 0o700 });
  assertTrustedControlPath(canonicalTrustedRoot, controlRoot, "trusted Git control directory");
  return controlRoot;
}

function assertTrustedControlPath(root: string, candidate: string, description: string): void {
  const rootReal = fs.realpathSync(root);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`${description} must not be a symbolic link`);
  const candidateReal = fs.realpathSync(candidate);
  const relative = path.relative(rootReal, candidateReal);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${description} escaped the trusted Git root`);
  }
}

function ensureTrustedAskPass(controlRoot: string): string {
  assertTrustedControlPath(path.dirname(controlRoot), controlRoot, "trusted Git control directory");
  const scriptPath = path.join(controlRoot, "askpass.cjs");
  fs.writeFileSync(
    scriptPath,
    [
      'const prompt = process.argv.slice(2).join(" ");',
      "const candidate = prompt.match(/https:\\/\\/[^\\s'\"]+/i)?.[0] || '';",
      "let target; try { target = new URL(candidate); } catch { process.exit(1); }",
      'if (target.protocol !== "https:" || target.hostname.toLowerCase() !== "github.com" || target.port) process.exit(1);',
      'const answer = /username/i.test(prompt) ? "x-access-token" : /password/i.test(prompt) ? (process.env.CLAWSWEEPER_TRUSTED_GIT_TOKEN || "") : "";',
      "if (!answer) process.exit(1);",
      "process.stdout.write(`${answer}\\n`);",
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  assertTrustedControlPath(controlRoot, scriptPath, "trusted askpass script");
  if (process.platform === "win32") {
    const commandPath = path.join(controlRoot, "askpass.cmd");
    fs.writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, {
      flag: "wx",
      mode: 0o700,
    });
    assertTrustedControlPath(controlRoot, commandPath, "trusted askpass launcher");
    return commandPath;
  }
  const commandPath = path.join(controlRoot, "askpass.sh");
  fs.writeFileSync(
    commandPath,
    `#!/bin/sh\nexec '${shellSingleQuote(process.execPath)}' '${shellSingleQuote(scriptPath)}' "$@"\n`,
    { flag: "wx", mode: 0o700 },
  );
  assertTrustedControlPath(controlRoot, commandPath, "trusted askpass launcher");
  return commandPath;
}

function shellSingleQuote(value: string): string {
  return value.replaceAll("'", `'"'"'`);
}
