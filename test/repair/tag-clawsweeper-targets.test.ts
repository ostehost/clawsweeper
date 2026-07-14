import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("label tagging uses retrying GitHub helpers", () => {
  const source = readFileSync("src/repair/tag-clawsweeper-targets.ts", "utf8");

  assert.match(source, /import \{ ghJsonWithRetry, ghTextWithRetry \} from "\.\/github-cli\.js"/);
  assert.doesNotMatch(source, /import \{ ghJson, ghText \} from "\.\/github-cli\.js"/);
  assert.match(source, /const labels = ghJsonWithRetry\(\[/);
  assert.match(
    source,
    /return ghJsonWithRetry\(\["api", `repos\/\$\{repo\}\/issues\/\$\{number\}`]\)/,
  );
  assert.match(source, /ghTextWithRetry\(\[\s*"issue",\s*"edit"/);
});

test("label tagging is non-blocking in repair workers", () => {
  const workflow = readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const step = workflow.split("- name: Tag ClawSweeper targets")[1]?.split("\n      - name: ")[0];

  assert.ok(step, "expected Tag ClawSweeper targets step");
  assert.match(step, /continue-on-error: true/);
});
