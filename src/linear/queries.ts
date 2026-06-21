// GraphQL queries for the Linear read-only item source.
// All queries use cursor-based pagination via pageInfo { hasNextPage endCursor }.

export const TEAMS_QUERY = `
  query ListTeams($first: Int!, $after: String) {
    teams(first: $first, after: $after) {
      nodes {
        id
        key
        name
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const PROJECTS_QUERY = `
  query ListProjects($teamId: ID!, $first: Int!, $after: String) {
    team(id: $teamId) {
      projects(first: $first, after: $after) {
        nodes {
          id
          name
          state
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

// Issues are filtered by team and optionally by updatedAt, ordered by updatedAt
// for efficient incremental sweeps (only process what changed since last run).
export const ISSUES_QUERY = `
  query ListIssues($teamId: ID!, $updatedAfter: DateComparator, $first: Int!, $after: String) {
    issues(
      first: $first
      after: $after
      orderBy: updatedAt
      filter: {
        team: { id: { eq: $teamId } }
        updatedAt: $updatedAfter
      }
    ) {
      nodes {
        id
        identifier
        title
        url
        createdAt
        updatedAt
        priority
        team {
          id
        }
        project {
          id
        }
        state {
          name
          type
        }
        labels {
          nodes {
            id
            name
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
