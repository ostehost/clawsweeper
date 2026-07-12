import type { JsonValue, LooseRecord } from "./json-types.js";

export interface RepairContract {
  mustTouch: string[];
  match: "any" | "all";
}

export function repairContract(fixArtifact: LooseRecord): RepairContract | null {
  const raw = fixArtifact.repair_contract;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (validateRepairContractShape(fixArtifact).length > 0) return null;
  const mustTouch = uniqueStrings(raw.must_touch.map(normalizeRepairContractPath));
  return {
    mustTouch,
    match: raw.match,
  };
}

export function enforceRepairContract({
  fixArtifact,
  changedFiles: rawChangedFiles,
}: {
  fixArtifact: LooseRecord;
  changedFiles: readonly string[];
}): void {
  const contract = repairContract(fixArtifact);
  if (!contract) return;

  const changedFiles = uniqueStrings(
    rawChangedFiles.map(normalizeRepairContractPath).filter(Boolean),
  );
  const matched = contract.mustTouch.filter((expected) =>
    changedFiles.some((file) => changedFileMatchesContract(file, expected)),
  );
  const ok =
    contract.match === "all" ? matched.length === contract.mustTouch.length : matched.length > 0;
  if (ok) return;

  const missing = contract.mustTouch.filter((expected) => !matched.includes(expected));
  throw new Error(
    [
      "repair contract rejected final repair tree: required paths are missing from the final branch delta",
      `match=${contract.match}`,
      `must_touch=${contract.mustTouch.join(", ")}`,
      `matched=${matched.join(", ") || "none"}`,
      `missing=${missing.join(", ") || "none"}`,
      `changed_files=${changedFiles.join(", ") || "none"}`,
    ].join("; "),
  );
}

export function changedFilesFromNameOnlyZ(diff: string): string[] {
  return uniqueStrings(diff.split("\0").map(normalizeRepairContractPath).filter(Boolean));
}

export function validateRepairContractShape(fixArtifact: LooseRecord): string[] {
  const raw = fixArtifact.repair_contract;
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return ["fix_artifact.repair_contract must be an object when present"];
  }

  const errors: string[] = [];
  const allowedKeys = new Set(["must_touch", "match"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      errors.push(`fix_artifact.repair_contract.${key} is not allowed`);
    }
  }
  if (!Array.isArray(raw.must_touch) || raw.must_touch.length === 0) {
    errors.push("fix_artifact.repair_contract.must_touch must be a non-empty list");
  }
  for (const value of Array.isArray(raw.must_touch) ? raw.must_touch : []) {
    if (typeof value !== "string") {
      errors.push("fix_artifact.repair_contract.must_touch entries must be strings");
      continue;
    }
    if (!normalizeRepairContractPath(value)) {
      errors.push(
        `fix_artifact.repair_contract.must_touch contains an unsafe path: ${String(value)}`,
      );
    }
  }
  if (raw.match !== "any" && raw.match !== "all") {
    errors.push("fix_artifact.repair_contract.match must be any or all");
  }
  if (fixArtifact.deterministic_rebase_only === true) {
    errors.push(
      "fix_artifact.repair_contract is incompatible with deterministic_rebase_only because a pure base sync has no repair delta",
    );
  }
  return errors;
}

function changedFileMatchesContract(changedFile: string, expected: string): boolean {
  const prefix = expected.replace(/\/$/, "");
  return changedFile === expected || changedFile.startsWith(`${prefix}/`);
}

function normalizeRepairContractPath(value: JsonValue): string {
  const pathValue = String(value ?? "").trim();
  if (!pathValue || pathValue.startsWith("/") || pathValue.includes("\0")) return "";
  if (/[`$;&|<>()[\]{}*?~]/.test(pathValue)) return "";
  if (pathValue.split(/[\\/]/).includes("..")) return "";
  return pathValue.replace(/^\.\//, "");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
