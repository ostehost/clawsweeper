import type { LooseRecord } from "./json-types.js";
import { ghStdoutFromError, ghText } from "./github-cli.js";

export type GithubRef = {
  repo: string;
  number: string;
};

export type GithubPullInfo = {
  html_url: string;
  merged: boolean;
  merged_at: string | null;
  state: string | null;
  title: string | null;
};

export type GithubIssueInfo = GithubPullInfo & {
  kind: "issue" | "pull_request";
  closed_at: string | null;
};

const PR_INFO_CACHE = new Map<string, GithubPullInfo | null>();
const ISSUE_INFO_CACHE = new Map<string, GithubIssueInfo | null>();

export function githubPullInfo(rows: LooseRecord[]): Map<string, GithubPullInfo | null> {
  const byRepo = new Map<string, Set<string>>();
  for (const row of rows) {
    const repo = String(row.repo ?? "");
    const number = row.number == null ? "" : String(row.number);
    if (!repo || !number) continue;
    const key = `${repo}#${number}`;
    if (PR_INFO_CACHE.has(key)) continue;
    const numbers = byRepo.get(repo) ?? new Set<string>();
    numbers.add(number);
    byRepo.set(repo, numbers);
  }

  for (const [repo, numbers] of byRepo) {
    for (const batch of chunks([...numbers], 50)) {
      for (const [key, info] of githubPullInfoBatch(repo, batch)) {
        PR_INFO_CACHE.set(key, info);
      }
      for (const number of batch) {
        const key = `${repo}#${number}`;
        if (!PR_INFO_CACHE.has(key)) PR_INFO_CACHE.set(key, null);
      }
    }
  }

  return new Map(
    rows.map((row: LooseRecord) => {
      const repo = String(row.repo ?? "");
      const number = row.number == null ? "" : String(row.number);
      return [`${repo}#${number}`, PR_INFO_CACHE.get(`${repo}#${number}`) ?? null];
    }),
  );
}

export function githubIssueInfo(rows: LooseRecord[]): Map<string, GithubIssueInfo | null> {
  const byRepo = new Map<string, Set<string>>();
  for (const row of rows) {
    const target = parseGithubIssueRef(
      String(row.record?.repo ?? row.repo ?? ""),
      row.action?.target ?? row.target,
    );
    if (!target) continue;
    const key = `${target.repo}#${target.number}`;
    if (ISSUE_INFO_CACHE.has(key)) continue;
    const numbers = byRepo.get(target.repo) ?? new Set<string>();
    numbers.add(target.number);
    byRepo.set(target.repo, numbers);
  }

  for (const [repo, numbers] of byRepo) {
    for (const batch of chunks([...numbers], 50)) {
      for (const [key, info] of githubIssueInfoBatch(repo, batch)) {
        ISSUE_INFO_CACHE.set(key, info);
      }
      for (const number of batch) {
        const key = `${repo}#${number}`;
        if (!ISSUE_INFO_CACHE.has(key)) ISSUE_INFO_CACHE.set(key, null);
      }
    }
  }

  return new Map(
    rows.map((row: LooseRecord) => {
      const target = parseGithubIssueRef(
        String(row.record?.repo ?? row.repo ?? ""),
        row.action?.target ?? row.target,
      );
      return target
        ? [
            `${target.repo}#${target.number}`,
            ISSUE_INFO_CACHE.get(`${target.repo}#${target.number}`) ?? null,
          ]
        : ["", null];
    }),
  );
}

export function parseGithubPullRef(defaultRepo: string, value: unknown): GithubRef | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let match = text.match(/^#?(\d+)$/);
  if (match && defaultRepo) return { repo: defaultRepo, number: match[1] ?? "" };
  match = text.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (match) return { repo: match[1] ?? "", number: match[2] ?? "" };
  match = text.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (match) return { repo: `${match[1]}/${match[2]}`, number: match[3] ?? "" };
  return null;
}

export function parseGithubIssueRef(defaultRepo: string, value: unknown): GithubRef | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let match = text.match(/^#?(\d+)$/);
  if (match && defaultRepo) return { repo: defaultRepo, number: match[1] ?? "" };
  match = text.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (match) return { repo: match[1] ?? "", number: match[2] ?? "" };
  match = text.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/);
  if (match) return { repo: `${match[1]}/${match[2]}`, number: match[3] ?? "" };
  return null;
}

export function isPullUrl(value: unknown): boolean {
  return /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(String(value ?? ""));
}

export function normalizePullState(state: unknown): string | null {
  if (!state) return null;
  return String(state).toLowerCase();
}

export function githubPullUrl(repo: string, ref: unknown): string {
  const number = String(ref ?? "").replace(/^#/, "");
  if (!/^\d+$/.test(number) || !repo) return "";
  return `https://github.com/${repo}/pull/${number}`;
}

export function githubIssueUrl(repo: string, ref: unknown): string {
  const number = String(ref ?? "").replace(/^#/, "");
  if (!/^\d+$/.test(number) || !repo) return "";
  return `https://github.com/${repo}/issues/${number}`;
}

export function earlierIso(left: unknown, right: unknown): unknown {
  if (!left) return right ?? null;
  if (!right) return left;
  return String(left).localeCompare(String(right)) <= 0 ? left : right;
}

function githubIssueInfoBatch(repo: string, numbers: string[]): Map<string, GithubIssueInfo> {
  const [owner, name] = String(repo).split("/");
  if (!owner || !name || numbers.length === 0) return new Map<string, GithubIssueInfo>();
  const fields = numbers
    .map(
      (number: string, index: number) =>
        `i${index}: issueOrPullRequest(number: ${Number(number)}) { __typename ... on Issue { number title state closedAt url } ... on PullRequest { number title state closedAt merged mergedAt url } }`,
    )
    .join("\n");
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
  const body = runGhGraphql(query);
  if (!body) return new Map<string, GithubIssueInfo>();
  const data = parseGithubResponse(body, `issue info for ${repo}`);
  if (!data) return new Map<string, GithubIssueInfo>();
  const repository = data?.data?.repository ?? {};
  const out = new Map<string, GithubIssueInfo>();
  numbers.forEach((number: string, index: number) => {
    const info = repository[`i${index}`];
    if (!info) return;
    out.set(`${repo}#${number}`, {
      html_url: info.url ?? githubIssueUrl(repo, number),
      kind: info.__typename === "PullRequest" ? "pull_request" : "issue",
      closed_at: info.closedAt ?? info.mergedAt ?? null,
      merged: Boolean(info.merged),
      merged_at: info.mergedAt ?? null,
      state: normalizePullState(info.state),
      title: info.title ?? null,
    });
  });
  return out;
}

function githubPullInfoBatch(repo: string, numbers: string[]): Map<string, GithubPullInfo> {
  const [owner, name] = String(repo).split("/");
  if (!owner || !name || numbers.length === 0) return new Map<string, GithubPullInfo>();
  const fields = numbers
    .map(
      (number: string, index: number) =>
        `p${index}: pullRequest(number: ${Number(number)}) { number title state merged mergedAt url }`,
    )
    .join("\n");
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
  const body = runGhGraphql(query);
  if (!body) return new Map<string, GithubPullInfo>();
  const data = parseGithubResponse(body, `pull info for ${repo}`);
  if (!data) return new Map<string, GithubPullInfo>();
  const repository = data?.data?.repository ?? {};
  const out = new Map<string, GithubPullInfo>();
  numbers.forEach((number: string, index: number) => {
    const info = repository[`p${index}`];
    if (!info) return;
    out.set(`${repo}#${number}`, {
      html_url: info.url ?? githubPullUrl(repo, number),
      merged: Boolean(info.merged),
      merged_at: info.mergedAt ?? null,
      state: normalizePullState(info.state),
      title: info.title ?? null,
    });
  });
  return out;
}

function runGhGraphql(query: string): string {
  try {
    return ghText(["api", "graphql", "-f", `query=${query}`]);
  } catch (error) {
    return ghStdoutFromError(error);
  }
}

export function parseGithubResponse(body: unknown, context: string): LooseRecord | null {
  const text = String(body ?? "").trim();
  if (!text) return null;
  if (!text.startsWith("{") && !text.startsWith("[")) {
    console.warn(`warning: ignoring non-json GitHub response for ${context}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`warning: could not parse GitHub response for ${context}: ${message}`);
    return null;
  }
}

function chunks(values: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}
