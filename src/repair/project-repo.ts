import { runText } from "../command.js";
import { repoRoot } from "./paths.js";

export function currentProjectRepo() {
  return (
    process.env.CLAWSWEEPER_REPO ||
    process.env.GITHUB_REPOSITORY ||
    repoFromOriginRemote() ||
    "openclaw/clawsweeper"
  );
}

export function githubActionsRunUrl(runId: string) {
  return `https://github.com/${currentProjectRepo()}/actions/runs/${runId}`;
}

function repoFromOriginRemote() {
  try {
    const remote = runText("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoRoot(),
      stdio: ["ignore", "pipe", "ignore"],
      trim: "both",
    });
    const sshMatch = remote.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = remote.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
  } catch {
    return null;
  }
  return null;
}
