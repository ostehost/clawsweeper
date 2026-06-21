import type { LinearTransport } from "./client.js";
import { ISSUES_QUERY, PROJECTS_QUERY, TEAMS_QUERY } from "./queries.js";
import type {
  LinearConnection,
  LinearIssue,
  LinearLabel,
  LinearProject,
  LinearTeam,
  ListIssuesOptions,
  WorkspaceItem,
  WorkspaceSweepOptions,
} from "./types.js";

// Narrowing helpers — Linear GraphQL data is untyped `unknown` from the transport.

function asConnection<T>(value: unknown, queryName: string): LinearConnection<T> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("nodes" in value) ||
    !("pageInfo" in value)
  ) {
    throw new Error(`Malformed connection from ${queryName}: expected { nodes, pageInfo }`);
  }
  return value as LinearConnection<T>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

// Shared cursor-based pagination loop. Calls `extract` on each page's data object
// to get the connection, maps each node with `map`, and yields results.
async function* paginate<TRaw, TOut>(
  transport: LinearTransport,
  query: string,
  baseVars: Record<string, unknown>,
  extract: (data: unknown) => LinearConnection<TRaw>,
  map: (raw: TRaw) => TOut,
  pageSize: number,
): AsyncGenerator<TOut> {
  let after: string | undefined;

  while (true) {
    const vars: Record<string, unknown> = { ...baseVars, first: pageSize };
    if (after != null) vars["after"] = after;

    const data = await transport(query, vars);
    const connection = extract(data);

    for (const node of connection.nodes) {
      yield map(node);
    }

    if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor == null) break;
    after = connection.pageInfo.endCursor;
  }
}

function mapTeam(raw: unknown): LinearTeam {
  const r = asRecord(raw);
  return { id: str(r["id"]), key: str(r["key"]), name: str(r["name"]) };
}

function mapProject(raw: unknown, teamId: string): LinearProject {
  const r = asRecord(raw);
  return {
    id: str(r["id"]),
    name: str(r["name"]),
    teamId,
    state: strOrNull(r["state"]),
  };
}

function mapLabels(raw: unknown): LinearLabel[] {
  const r = asRecord(raw);
  const nodes = r["nodes"];
  if (!Array.isArray(nodes)) return [];
  return nodes.map((n) => {
    const ln = asRecord(n);
    return { id: str(ln["id"]), name: str(ln["name"]) };
  });
}

function mapIssue(raw: unknown): LinearIssue {
  const r = asRecord(raw);
  const team = asRecord(r["team"]);
  const project = r["project"] != null ? asRecord(r["project"]) : null;
  const state = r["state"] != null ? asRecord(r["state"]) : null;
  return {
    id: str(r["id"]),
    identifier: str(r["identifier"]),
    title: str(r["title"]),
    url: str(r["url"]),
    createdAt: str(r["createdAt"]),
    updatedAt: str(r["updatedAt"]),
    priority: num(r["priority"]),
    teamId: str(team["id"]),
    projectId: project != null ? strOrNull(project["id"]) : null,
    stateId: state != null ? strOrNull(state["id"]) : null,
    stateName: state != null ? strOrNull(state["name"]) : null,
    stateType: state != null ? strOrNull(state["type"]) : null,
    labels: mapLabels(r["labels"]),
  };
}

export class LinearItemSource {
  constructor(private transport: LinearTransport) {}

  async *iterateTeams(pageSize = 250): AsyncGenerator<LinearTeam> {
    yield* paginate(
      this.transport,
      TEAMS_QUERY,
      {},
      (data) => asConnection<unknown>(asRecord(data)["teams"], "ListTeams"),
      mapTeam,
      pageSize,
    );
  }

  async *iterateProjects(teamId: string, pageSize = 250): AsyncGenerator<LinearProject> {
    yield* paginate(
      this.transport,
      PROJECTS_QUERY,
      { teamId },
      (data) => {
        const team = asRecord(asRecord(data)["team"]);
        return asConnection<unknown>(team["projects"], "ListProjects");
      },
      (raw) => mapProject(raw, teamId),
      pageSize,
    );
  }

  async *iterateIssues(options: ListIssuesOptions): AsyncGenerator<LinearIssue> {
    const { teamId, updatedAfter, pageSize = 250 } = options;
    // Build the updatedAt filter only when a date is provided.
    const vars: Record<string, unknown> = { teamId };
    if (updatedAfter != null) {
      vars["updatedAfter"] = { gt: updatedAfter };
    }
    yield* paginate(
      this.transport,
      ISSUES_QUERY,
      vars,
      (data) => asConnection<unknown>(asRecord(data)["issues"], "ListIssues"),
      mapIssue,
      pageSize,
    );
  }

  async listTeams(pageSize?: number): Promise<LinearTeam[]> {
    const results: LinearTeam[] = [];
    for await (const team of this.iterateTeams(pageSize)) results.push(team);
    return results;
  }

  async listProjects(teamId: string, pageSize?: number): Promise<LinearProject[]> {
    const results: LinearProject[] = [];
    for await (const project of this.iterateProjects(teamId, pageSize)) results.push(project);
    return results;
  }

  async listIssues(options: ListIssuesOptions): Promise<LinearIssue[]> {
    const results: LinearIssue[] = [];
    for await (const issue of this.iterateIssues(options)) results.push(issue);
    return results;
  }

  async *iterateWorkspaceItems(options?: WorkspaceSweepOptions): AsyncGenerator<WorkspaceItem> {
    const { updatedAfter, pageSize } = options ?? {};
    for await (const team of this.iterateTeams(pageSize)) {
      const projects = await this.listProjects(team.id, pageSize);
      const projectMap = new Map<string, LinearProject>(projects.map((p) => [p.id, p]));
      // Build issue options, omitting optional keys when undefined (exactOptionalPropertyTypes).
      const issueOpts: ListIssuesOptions = { teamId: team.id };
      if (updatedAfter !== undefined) issueOpts.updatedAfter = updatedAfter;
      if (pageSize !== undefined) issueOpts.pageSize = pageSize;
      for await (const issue of this.iterateIssues(issueOpts)) {
        const project = issue.projectId != null ? (projectMap.get(issue.projectId) ?? null) : null;
        yield { team, project, issue };
      }
    }
  }

  async listWorkspaceItems(options?: WorkspaceSweepOptions): Promise<WorkspaceItem[]> {
    const results: WorkspaceItem[] = [];
    for await (const item of this.iterateWorkspaceItems(options)) results.push(item);
    return results;
  }
}
