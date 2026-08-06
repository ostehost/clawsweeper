export const LINEAR_LIVE_FIXTURE_CONTRACT = "readonly-issue-v1";

const LINEAR_LIVE_BUILD_ENV_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "COREPACK_HOME",
  "PNPM_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
]);

export function buildLinearLiveBuildEnv(source) {
  const env = {};
  for (const key of LINEAR_LIVE_BUILD_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  return env;
}

export function scrubLinearCredentialEnvironment(env) {
  for (const key of Object.keys(env)) {
    if (
      /^LINEAR(?:_|$)/i.test(key) ||
      /^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|CODEX_HOME)$/i.test(key)
    ) {
      delete env[key];
    }
  }
}

export const LINEAR_LIVE_FIXTURE = Object.freeze({
  titlePrefix: "[ClawSweeper E2E] read-only proof fixture",
  description:
    "Ephemeral caller-owned fixture for ClawSweeper's proposal-only Linear read proof. Safe to delete.",
  priority: 4,
});

export function buildLinearLiveFixture(correlationId) {
  if (!/^[0-9a-f-]{36}$/i.test(correlationId)) {
    throw new Error("Linear E2E fixture correlation id is invalid");
  }
  return {
    title: `${LINEAR_LIVE_FIXTURE.titlePrefix} ${correlationId}`,
    description: LINEAR_LIVE_FIXTURE.description,
    priority: LINEAR_LIVE_FIXTURE.priority,
  };
}

export const ISSUE_CREATE_E2E_FIXTURE_MUTATION = `
  mutation IssueCreateE2EFixture($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
      }
    }
  }
`;

export const ISSUE_DELETE_E2E_FIXTURE_MUTATION = `
  mutation IssueDeleteE2EFixture($id: String!) {
    issueDelete(id: $id) {
      success
    }
  }
`;
