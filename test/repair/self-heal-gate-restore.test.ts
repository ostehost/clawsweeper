import assert from "node:assert/strict";
import test from "node:test";

import {
  restoreGateSequence,
  restoreGateWithFallback,
} from "../../dist/repair/self-heal-gate-restore.js";

test("self-heal gate restoration falls back when receipt creation fails", () => {
  const receiptError = new Error("receipt unavailable");
  let writes = 0;
  const result = restoreGateWithFallback({
    runWithReceipt: () => {
      throw receiptError;
    },
    writeState: () => {
      writes += 1;
    },
  });

  assert.equal(writes, 1);
  assert.equal(result.receiptError, receiptError);
  assert.equal(result.restoreError, null);
});

test("self-heal gate restoration does not replay a completed write after receipt failure", () => {
  const receiptError = new Error("outcome receipt unavailable");
  let writes = 0;
  const result = restoreGateWithFallback({
    runWithReceipt: (operation) => {
      operation();
      throw receiptError;
    },
    writeState: () => {
      writes += 1;
    },
  });

  assert.equal(writes, 1);
  assert.equal(result.receiptError, receiptError);
  assert.equal(result.restoreError, null);
});

test("self-heal attempts every gate restore independently in reverse order", () => {
  const calls: string[] = [];
  const firstError = new Error("fix gate failed");
  const result = restoreGateSequence(
    [
      { name: "execute", state: "0" },
      { name: "fix", state: "" },
    ],
    (name) => {
      calls.push(name);
      return name === "fix"
        ? { receiptError: null, restoreError: firstError }
        : { receiptError: null, restoreError: null };
    },
  );

  assert.deepEqual(calls, ["fix", "execute"]);
  assert.deepEqual(result.receiptFailures, []);
  assert.deepEqual(result.restoreFailures, [{ name: "fix", error: firstError }]);
});
