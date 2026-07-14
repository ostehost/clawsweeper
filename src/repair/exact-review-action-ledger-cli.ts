#!/usr/bin/env node
import fs from "node:fs";

import {
  runExactReviewQueueCommand,
  type ExactReviewQueueCommand,
} from "./exact-review-action-ledger.js";

const command = process.argv[2] as ExactReviewQueueCommand | undefined;

try {
  if (!command || !["enqueue", "claim", "complete", "reconcile"].includes(command)) {
    throw new Error("usage: exact-review-action-ledger-cli.ts <enqueue|claim|complete|reconcile>");
  }
  const outputs = await runExactReviewQueueCommand(command);
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (outputPath && Object.keys(outputs).length > 0) {
    fs.appendFileSync(
      outputPath,
      `${Object.entries(outputs)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
    );
  }
} catch {
  console.error(`exact-review ${command ?? "unknown"} request failed`);
  process.exitCode = 1;
}
