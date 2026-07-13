import { ghJson } from "./github-cli.js";
import type { LooseRecord } from "./json-types.js";

const WORKFLOW_RUN_PAGE_SIZE = 100;
const DEFAULT_WORKFLOW_RUN_PAGE_LIMIT = 100;

export function fetchWorkflowRunHistory({
  repo,
  workflow,
  cutoffMs,
  maxPages = DEFAULT_WORKFLOW_RUN_PAGE_LIMIT,
  fetchPage = ghJson,
}: {
  repo: string;
  workflow: string;
  cutoffMs: number;
  maxPages?: number;
  fetchPage?: typeof ghJson;
}): LooseRecord[] {
  const runs: LooseRecord[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const pageRuns = fetchPage<LooseRecord[]>([
      "api",
      "--method",
      "GET",
      `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${WORKFLOW_RUN_PAGE_SIZE}&page=${page}`,
      "--jq",
      ".workflow_runs",
    ]);
    if (!Array.isArray(pageRuns)) {
      throw new Error("workflow run discovery returned a non-array response");
    }
    runs.push(...pageRuns.map(normalizeWorkflowRun));
    if (
      pageRuns.length < WORKFLOW_RUN_PAGE_SIZE ||
      pageRuns.some((run) => {
        const createdAtMs = Date.parse(String(run.created_at ?? run.createdAt ?? ""));
        return Number.isFinite(createdAtMs) && createdAtMs <= cutoffMs;
      })
    ) {
      return runs;
    }
  }
  throw new Error(
    `workflow run discovery exceeded ${maxPages * WORKFLOW_RUN_PAGE_SIZE} runs before reaching the requested horizon`,
  );
}

function normalizeWorkflowRun(run: LooseRecord): LooseRecord {
  return {
    databaseId: run.databaseId ?? run.id,
    workflowName: run.workflowName ?? run.name,
    displayTitle: run.displayTitle ?? run.display_title,
    headSha: run.headSha ?? run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.createdAt ?? run.created_at,
    updatedAt: run.updatedAt ?? run.updated_at,
    url: run.url ?? run.html_url,
  };
}
