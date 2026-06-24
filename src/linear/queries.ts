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
  query ListProjects($teamId: String!, $first: Int!, $after: String) {
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
          id
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

// Fetch a single issue by its human identifier (team key + number, e.g. "PAR-244"),
// scoped to one team. Hydrates the issue's comments in the SAME read pass so a comment
// upsert can be planned without snapshot/comment drift. Returns at most one node.
export const ISSUE_BY_IDENTIFIER_QUERY = `
  query IssueByIdentifier(
    $teamKey: String!
    $number: Float!
    $first: Int!
    $after: String
    $commentFirst: Int!
    $commentAfter: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        team: { key: { eq: $teamKey } }
        number: { eq: $number }
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
          key
          name
        }
        project {
          id
          name
          state
        }
        state {
          id
          name
          type
        }
        labels {
          nodes {
            id
            name
          }
        }
        comments(first: $commentFirst, after: $commentAfter) {
          nodes {
            id
            body
          }
          pageInfo {
            hasNextPage
            endCursor
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
