export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearProject {
  id: string;
  name: string;
  teamId: string;
  state: string | null;
}

export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  teamId: string;
  projectId: string | null;
  stateName: string | null;
  stateType: string | null;
  priority: number;
  labels: LinearLabel[];
}

export interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface LinearConnection<T> {
  nodes: T[];
  pageInfo: LinearPageInfo;
}

export interface ListIssuesOptions {
  teamId: string;
  updatedAfter?: string;
  pageSize?: number;
}

export interface WorkspaceSweepOptions {
  updatedAfter?: string;
  pageSize?: number;
}

export interface WorkspaceItem {
  team: LinearTeam;
  project: LinearProject | null;
  issue: LinearIssue;
}
