import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexEnvOptions = {
  ghToken?: string | undefined;
  preserveCodexAuth?: boolean | undefined;
};

export type CodexLoginMethod = "api" | "chatgpt";

export const PUBLIC_CODEX_MODEL = "internal";
const CODEX_SENSITIVE_ENV_NAME =
  /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?|PRIVATE)(?:_|$)/i;
const CODEX_ACTIONS_CREDENTIAL_ENV = [
  "ACTIONS_CACHE_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "GITHUB_ACTIONS_RUNTIME_TOKEN",
] as const;
const CODEX_ACTIONS_COMMAND_ENV = [
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
] as const;
const CODEX_EXPLICIT_SENSITIVE_ENV = new Set([
  ...CODEX_ACTIONS_CREDENTIAL_ENV,
  "CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL",
  "CLAWSWEEPER_CRABFLEET_WORK_STATE_URL",
]);
const CODEX_AUTH_ENV = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]);

export function codexLoginMethod(
  value = process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD,
): CodexLoginMethod {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "api";
  if (normalized === "api" || normalized === "chatgpt") return normalized;
  throw new Error(`Invalid CLAWSWEEPER_CODEX_LOGIN_METHOD: ${value}. Expected "api" or "chatgpt".`);
}

export function codexLoginConfig(value?: string): string {
  return `forced_login_method="${codexLoginMethod(value)}"`;
}

export function internalCodexModel(requestedModel: string): string {
  return process.env.CLAWSWEEPER_INTERNAL_MODEL?.trim() || requestedModel;
}

export function codexModelArgs(requestedModel: string): string[] {
  const model = String(requestedModel ?? "").trim();
  const internalModel = process.env.CLAWSWEEPER_INTERNAL_MODEL?.trim();
  if (!model || model === PUBLIC_CODEX_MODEL || (internalModel && model === internalModel))
    return [];
  return ["--model", model];
}

export function redactInternalCodexModel(
  value: string | null | undefined,
  codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
): string {
  let redacted = value ?? "";
  for (const model of codexInternalModelValues(codexHome)) {
    redacted = redacted.replaceAll(model, "[REDACTED_INTERNAL_MODEL]");
  }
  return redacted.replace(
    /(Rate limit reached for\s+)\S+(?=\s+(?:\(for limit\b|on (?:tokens|requests) per min\b))/gi,
    "$1[REDACTED_INTERNAL_MODEL]",
  );
}

export function codexInternalModelValues(
  codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
): string[] {
  const configuredModels = [process.env.CLAWSWEEPER_INTERNAL_MODEL?.trim() ?? ""];
  const configPath = codexHome ? join(codexHome, "config.toml") : "";
  if (configPath && existsSync(configPath)) {
    const match = readFileSync(configPath, "utf8").match(
      /^\s*model\s*=\s*("(?:\\.|[^"\\])*")\s*$/m,
    );
    if (match?.[1]) {
      try {
        configuredModels.push(String(JSON.parse(match[1])).trim());
      } catch {
        // Malformed config is a Codex setup failure, not a reason to expose its contents.
      }
    }
  }
  return [...new Set(configuredModels.filter(Boolean))];
}

export function codexEnv(options: CodexEnvOptions = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const ghToken = options.ghToken?.trim();
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.COMMIT_SWEEPER_TARGET_GH_TOKEN;
  delete env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN;
  delete env.CLAWSWEEPER_APP_ID;
  delete env.CLAWSWEEPER_APP_PRIVATE_KEY;
  delete env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN;
  delete env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL;
  delete env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL;
  for (const key of CODEX_ACTIONS_CREDENTIAL_ENV) delete env[key];
  for (const key of CODEX_ACTIONS_COMMAND_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (
      (/^CLAWSWEEPER_.*GH_TOKEN$/.test(key) || CODEX_SENSITIVE_ENV_NAME.test(key)) &&
      !(options.preserveCodexAuth && CODEX_AUTH_ENV.has(key))
    ) {
      delete env[key];
    }
  }
  if (!options.preserveCodexAuth) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
  }
  delete env.CLAWSWEEPER_INTERNAL_MODEL;
  if (ghToken) env.GH_TOKEN = ghToken;
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export function codexSensitiveEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...new Set(
      Object.entries(env)
        .filter(
          ([name]) => CODEX_EXPLICIT_SENSITIVE_ENV.has(name) || CODEX_SENSITIVE_ENV_NAME.test(name),
        )
        .map(([, value]) => String(value ?? "").trim())
        .filter((value) => value.length >= 6),
    ),
  ].sort((left, right) => right.length - left.length);
}
