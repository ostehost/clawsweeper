import type { JsonValue, LooseRecord } from "./json-types.js";

type GithubJsonReader = (args: string[]) => JsonValue;

const EXPECTED_BASE_BRANCH = "main";
const EXPECTED_BASE_REF = `refs/heads/${EXPECTED_BASE_BRANCH}`;
const NO_ATOMIC_BASE_BINDING =
  "automerge disabled: GitHub merge APIs cannot atomically bind the reviewed base branch";

export function runtimeStrictBaseBindingBlock({
  repo,
  baseBranch,
  policyReadJson,
  env = process.env,
}: {
  repo: string;
  baseBranch: string;
  policyReadJson?: GithubJsonReader | undefined;
  env?: NodeJS.ProcessEnv;
}): string {
  return serverStrictBaseBindingBlock({
    repo,
    baseBranch,
    configuredAppSlug: env.CLAWSWEEPER_APP_SLUG,
    authenticatedAppId: env.CLAWSWEEPER_AUTHENTICATED_APP_ID,
    appSlug: env.CLAWSWEEPER_AUTHENTICATED_APP_SLUG,
    installationId: env.CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID,
    policyReadJson,
  });
}

export function serverStrictBaseBindingBlock({
  repo,
  baseBranch,
  configuredAppSlug,
  authenticatedAppId,
  appSlug,
  installationId,
  policyReadJson,
}: {
  repo: string;
  baseBranch: string;
  configuredAppSlug: unknown;
  authenticatedAppId: unknown;
  appSlug: unknown;
  installationId: unknown;
  policyReadJson?: GithubJsonReader | undefined;
}): string {
  if (!baseBranch) {
    return "automerge disabled: pull request base branch is unavailable for strict binding";
  }
  if (baseBranch !== EXPECTED_BASE_BRANCH) {
    return `automerge disabled: pull request base branch must be ${EXPECTED_BASE_BRANCH} for strict binding`;
  }

  const configuredSlug = normalizedAppSlug(configuredAppSlug);
  const mutationIdentity = actionInstallationIdentity(authenticatedAppId, appSlug, installationId);
  if (!configuredSlug || !mutationIdentity || mutationIdentity.appSlug !== configuredSlug) {
    return "automerge disabled: merge credential is not a verifiable GitHub App installation";
  }
  if (!policyReadJson) {
    return "automerge disabled: mutation credential cannot read its effective rulesets";
  }
  let rulesListUnavailable = false;
  let strictRuleCount = 0;
  let verifiedStrictRuleCount = 0;
  let strictRuleUnavailable = false;
  let bypassedStrictRule = false;
  let weakenedStrictRule = false;
  try {
    const rules = fetchApplicableRules(repo, baseBranch, policyReadJson);
    if (!rules) {
      rulesListUnavailable = true;
    } else {
      for (const rule of rules) {
        if (!isStrictStatusCheckRule(rule)) continue;
        strictRuleCount += 1;
        const ruleset = fetchRuleset(rule, repo, policyReadJson);
        if (!ruleset) {
          strictRuleUnavailable = true;
          continue;
        }
        const callerBypassesRuleset = rulesetBypassesCaller(ruleset);
        if (callerBypassesRuleset === null) {
          strictRuleUnavailable = true;
          continue;
        }
        if (callerBypassesRuleset) {
          bypassedStrictRule = true;
          continue;
        }
        const weakensRequiredChecks = rulesetWeakensRequiredChecks(ruleset, rule);
        if (weakensRequiredChecks === null) {
          strictRuleUnavailable = true;
          continue;
        }
        if (weakensRequiredChecks) {
          weakenedStrictRule = true;
          continue;
        }
        verifiedStrictRuleCount += 1;
      }
    }
  } catch {
    rulesListUnavailable = true;
  }

  if (bypassedStrictRule) {
    return "automerge disabled: merge credential can bypass an applicable strict base-binding ruleset";
  }
  if (weakenedStrictRule) {
    return "automerge disabled: an applicable ruleset weakens required strict status checks";
  }
  if (rulesListUnavailable || strictRuleUnavailable) {
    return "automerge disabled: unable to verify every applicable strict base-binding ruleset";
  }
  if (strictRuleCount === 0) {
    return `automerge disabled: ${baseBranch} lacks a non-bypassable strict status-check ruleset`;
  }
  if (verifiedStrictRuleCount !== strictRuleCount) {
    return "automerge disabled: unable to verify every applicable strict base-binding ruleset";
  }

  const policyBlock = uniqueMainUpdateBindingBlock(repo, policyReadJson);
  if (policyBlock) return policyBlock;

  // GitHub's REST and GraphQL merge operations can require an exact head SHA,
  // but neither accepts an expected base ref. Branch update restrictions do
  // not protect pull-request metadata, so another writer can retarget the PR
  // after our final read and before the merge. Keep every automated merge
  // route closed until the server offers an atomic base-bound primitive.
  return NO_ATOMIC_BASE_BINDING;
}

function uniqueMainUpdateBindingBlock(repo: string, readJson: GithubJsonReader): string {
  let summaries: LooseRecord[] | null = null;
  try {
    summaries = fetchBranchRulesetSummaries(repo, readJson);
  } catch {
    summaries = null;
  }
  if (!summaries) {
    return "automerge disabled: unable to verify the unique-main update restriction";
  }

  let uniqueMainRestrictionFound = false;
  const seenIds = new Set<number>();
  for (const summary of summaries) {
    const id = rulesetSummaryId(summary);
    if (!id || seenIds.has(id)) {
      return "automerge disabled: unable to verify the unique-main update restriction";
    }
    seenIds.add(id);

    if (summary.target !== "branch") {
      return "automerge disabled: unable to verify the unique-main update restriction";
    }
    if (!isKnownRulesetEnforcement(summary.enforcement)) {
      return "automerge disabled: unable to verify the unique-main update restriction";
    }
    if (summary.enforcement !== "active") continue;

    const details = fetchRulesetById(id, repo, readJson);
    if (!details || !isCompleteActiveBranchRuleset(details)) {
      return "automerge disabled: unable to verify the unique-main update restriction";
    }
    if (isUniqueMainUpdateRestriction(details)) uniqueMainRestrictionFound = true;
  }

  return uniqueMainRestrictionFound
    ? ""
    : "automerge disabled: GitHub cannot atomically bind the merge base and no non-bypassable rule blocks updates to every non-main branch";
}

function fetchBranchRulesetSummaries(
  repo: string,
  readJson: GithubJsonReader,
): LooseRecord[] | null {
  const pages = readJson([
    "api",
    `repos/${repo}/rulesets?includes_parents=true&targets=branch&per_page=100`,
    "--paginate",
    "--slurp",
  ]);
  if (!Array.isArray(pages)) return null;

  const summaries: LooseRecord[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) return null;
    for (const summary of page) {
      if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
      summaries.push(summary as LooseRecord);
    }
  }
  return summaries;
}

function rulesetSummaryId(summary: LooseRecord): number | null {
  const id = summary.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isKnownRulesetEnforcement(value: JsonValue): boolean {
  return ["active", "evaluate", "disabled"].includes(String(value ?? ""));
}

function isCompleteActiveBranchRuleset(ruleset: LooseRecord): boolean {
  if (ruleset.target !== "branch" || ruleset.enforcement !== "active") return false;
  if (rulesetBypassesCaller(ruleset) === null) return false;
  const conditions = ruleset.conditions;
  const refName = conditions?.ref_name;
  if (!stringArray(refName?.include) || !stringArray(refName?.exclude)) return false;
  if (!Array.isArray(ruleset.rules)) return false;
  return ruleset.rules.every(
    (rule: JsonValue) =>
      Boolean(rule) &&
      typeof rule === "object" &&
      !Array.isArray(rule) &&
      typeof (rule as LooseRecord).type === "string",
  );
}

function isUniqueMainUpdateRestriction(ruleset: LooseRecord): boolean {
  if (rulesetBypassesCaller(ruleset) !== false) return false;
  const refName = ruleset.conditions?.ref_name;
  const include = refName?.include as JsonValue[];
  const exclude = refName?.exclude as JsonValue[];
  if (include.length !== 1 || include[0] !== "~ALL") return false;
  if (exclude.length !== 1 || exclude[0] !== EXPECTED_BASE_REF) return false;

  return ruleset.rules.some((rule: JsonValue) => {
    const candidate = rule as LooseRecord;
    return (
      candidate?.type === "update" && candidate.parameters?.update_allows_fetch_and_merge === false
    );
  });
}

function stringArray(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function fetchApplicableRules(
  repo: string,
  baseBranch: string,
  readJson: GithubJsonReader,
): JsonValue[] | null {
  const pages = readJson([
    "api",
    `repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}?per_page=100`,
    "--paginate",
    "--slurp",
  ]);
  if (!Array.isArray(pages)) return null;

  const rules: JsonValue[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) return null;
    rules.push(...page);
  }
  return rules;
}

function actionInstallationIdentity(
  appId: unknown,
  appSlug: unknown,
  installationId: unknown,
): { appId: number; appSlug: string; installationId: number } | null {
  const normalizedAppId = Number(appId);
  const normalizedSlug = normalizedAppSlug(appSlug);
  const normalizedInstallationId = Number(installationId);
  if (
    !Number.isSafeInteger(normalizedAppId) ||
    normalizedAppId <= 0 ||
    !normalizedSlug ||
    !Number.isSafeInteger(normalizedInstallationId) ||
    normalizedInstallationId <= 0
  ) {
    return null;
  }
  return {
    appId: normalizedAppId,
    appSlug: normalizedSlug,
    installationId: normalizedInstallationId,
  };
}

function normalizedAppSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const appSlug = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(appSlug) ? appSlug : null;
}

function isStrictStatusCheckRule(rule: JsonValue): boolean {
  const candidate = rule as LooseRecord;
  const parameters = candidate?.parameters;
  return (
    candidate?.type === "required_status_checks" &&
    parameters?.strict_required_status_checks_policy === true &&
    Array.isArray(parameters.required_status_checks) &&
    parameters.required_status_checks.length > 0
  );
}

function fetchRuleset(
  rule: JsonValue,
  repo: string,
  readJson: GithubJsonReader,
): LooseRecord | null {
  const candidate = rule as LooseRecord;
  const id = Number(candidate?.ruleset_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return fetchRulesetById(id, repo, readJson);
}

function fetchRulesetById(
  id: number,
  repo: string,
  readJson: GithubJsonReader,
): LooseRecord | null {
  const endpoint = `repos/${repo}/rulesets/${id}?includes_parents=true`;
  try {
    const ruleset = readJson(["api", endpoint]);
    return ruleset && typeof ruleset === "object" && !Array.isArray(ruleset)
      ? (ruleset as LooseRecord)
      : null;
  } catch {
    return null;
  }
}

function rulesetBypassesCaller(ruleset: LooseRecord): boolean | null {
  const value = ruleset.current_user_can_bypass;
  if (value === "never") return false;
  if (["always", "pull_requests_only", "exempt"].includes(String(value))) return true;
  return null;
}

function rulesetWeakensRequiredChecks(
  ruleset: LooseRecord,
  effectiveRule: JsonValue,
): boolean | null {
  if (!Array.isArray(ruleset.rules)) return null;
  if (ruleset.enforcement !== "active") return true;
  const statusRules = ruleset.rules
    .map((rule: JsonValue) => rule as LooseRecord)
    .filter((rule: LooseRecord) => rule?.type === "required_status_checks");
  if (statusRules.length === 0) return true;
  if (
    statusRules.some(
      (rule: LooseRecord) => rule.parameters?.strict_required_status_checks_policy !== true,
    )
  ) {
    return true;
  }

  const expected = requiredStatusCheckIdentities((effectiveRule as LooseRecord)?.parameters);
  const actual = requiredStatusCheckIdentities({
    required_status_checks: statusRules.flatMap(
      (rule: LooseRecord) => rule.parameters?.required_status_checks ?? [],
    ),
  });
  if (!expected || !actual) return null;
  return [...expected].some((identity) => !actual.has(identity));
}

function requiredStatusCheckIdentities(parameters: LooseRecord): Set<string> | null {
  if (!Array.isArray(parameters?.required_status_checks)) return null;
  const identities = new Set<string>();
  for (const check of parameters.required_status_checks) {
    const candidate = check as LooseRecord;
    const context = String(candidate?.context ?? "").trim();
    if (!context) return null;
    const integrationId =
      candidate.integration_id === null || candidate.integration_id === undefined
        ? ""
        : String(candidate.integration_id);
    identities.add(`${context}\0${integrationId}`);
  }
  return identities.size > 0 ? identities : null;
}
