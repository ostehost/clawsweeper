export type GateRestoreResult = {
  receiptError: unknown | null;
  restoreError: unknown | null;
};

export type GateCleanupFailure = {
  error: unknown;
  name: string;
};

export function restoreGateWithFallback(options: {
  runWithReceipt: (operation: () => unknown) => unknown;
  writeState: () => unknown;
}): GateRestoreResult {
  let restoreStarted = false;
  let restoreCompleted = false;
  try {
    options.runWithReceipt(() => {
      restoreStarted = true;
      const result = options.writeState();
      restoreCompleted = true;
      return result;
    });
    return { receiptError: null, restoreError: null };
  } catch (error) {
    if (restoreCompleted) return { receiptError: error, restoreError: null };
    if (restoreStarted) return { receiptError: null, restoreError: error };
    try {
      options.writeState();
      return { receiptError: error, restoreError: null };
    } catch (restoreError) {
      return { receiptError: error, restoreError };
    }
  }
}

export function restoreGateSequence<T>(
  gates: { name: string; state: T }[],
  restore: (name: string, state: T) => GateRestoreResult,
): {
  receiptFailures: GateCleanupFailure[];
  restoreFailures: GateCleanupFailure[];
} {
  const receiptFailures: GateCleanupFailure[] = [];
  const restoreFailures: GateCleanupFailure[] = [];
  for (const gate of [...gates].reverse()) {
    const result = restore(gate.name, gate.state);
    if (result.receiptError !== null) {
      receiptFailures.push({ name: gate.name, error: result.receiptError });
    }
    if (result.restoreError !== null) {
      restoreFailures.push({ name: gate.name, error: result.restoreError });
    }
  }
  return { receiptFailures, restoreFailures };
}
