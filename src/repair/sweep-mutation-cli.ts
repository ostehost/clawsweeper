#!/usr/bin/env node
import { executeSweepMutation, type SweepMutationRequest } from "./sweep-mutation.js";

try {
  const request = parseSweepMutationArgs(process.argv.slice(2));
  const result = executeSweepMutation(request);
  console.log(`sweep mutation ${result.outcome} after ${result.attempts} attempt(s)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "sweep mutation failed");
  process.exitCode = 1;
}

export function parseSweepMutationArgs(argv: readonly string[]): SweepMutationRequest {
  const [resource, action, ...rest] = argv;
  const args = parseOptions(rest);
  const repository = required(args, "repo");

  if (resource === "reaction" && action === "add") {
    assertOnlyOptions(args, ["repo", "item-number", "content", "max-attempts"]);
    const maxAttempts = optionalPositiveInteger(args.get("max-attempts"), "max attempts");
    return {
      type: "reaction-add",
      repository,
      itemNumber: positiveInteger(required(args, "item-number"), "item number"),
      content: required(args, "content"),
      ...(maxAttempts ? { maxAttempts } : {}),
    };
  }
  if (resource === "reaction" && action === "delete") {
    assertOnlyOptions(args, ["repo", "item-number", "reaction-id", "max-attempts"]);
    const maxAttempts = optionalPositiveInteger(args.get("max-attempts"), "max attempts");
    return {
      type: "reaction-delete",
      repository,
      itemNumber: positiveInteger(required(args, "item-number"), "item number"),
      reactionId: positiveInteger(required(args, "reaction-id"), "reaction id"),
      ...(maxAttempts ? { maxAttempts } : {}),
    };
  }
  if (resource === "comment" && action === "delete") {
    assertOnlyOptions(args, ["repo", "item-number", "comment-id", "max-attempts"]);
    const maxAttempts = optionalPositiveInteger(args.get("max-attempts"), "max attempts");
    return {
      type: "comment-delete",
      repository,
      itemNumber: positiveInteger(required(args, "item-number"), "item number"),
      commentId: positiveInteger(required(args, "comment-id"), "comment id"),
      ...(maxAttempts ? { maxAttempts } : {}),
    };
  }
  if (resource === "workflow" && action === "dispatch") {
    assertOnlyOptions(args, [
      "repo",
      "workflow",
      "ref",
      "field",
      "target-repo",
      "item-number",
      "business-key",
    ]);
    const fields = Object.fromEntries(parseFields(args.get("field") ?? []));
    return {
      type: "workflow-dispatch",
      repository,
      workflow: required(args, "workflow"),
      ref: required(args, "ref"),
      fields,
      businessKey: required(args, "business-key"),
      ...optionalTarget(args),
    };
  }
  if (resource === "repository" && action === "dispatch") {
    assertOnlyOptions(args, [
      "repo",
      "event-type",
      "payload-file",
      "target-repo",
      "item-number",
      "business-key",
    ]);
    return {
      type: "repository-dispatch",
      repository,
      eventType: required(args, "event-type"),
      payloadPath: required(args, "payload-file"),
      businessKey: required(args, "business-key"),
      ...optionalTarget(args),
    };
  }
  throw new Error(
    "usage: sweep-mutation-cli.ts <reaction add|reaction delete|comment delete|workflow dispatch|repository dispatch> [options]",
  );
}

function parseOptions(argv: readonly string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    const name = token.slice(2, separator >= 0 ? separator : undefined);
    const value = separator >= 0 ? token.slice(separator + 1) : argv[++index];
    if (!name || value == null || value.startsWith("--")) {
      throw new Error(`missing value for --${name || "unknown"}`);
    }
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return values;
}

function required(args: Map<string, string[]>, name: string): string {
  const values = args.get(name) ?? [];
  if (values.length !== 1 || !values[0]?.trim())
    throw new Error(`--${name} is required exactly once`);
  return values[0];
}

function parseFields(values: readonly string[]): Array<[string, string]> {
  const fields: Array<[string, string]> = values.map((value) => {
    const separator = value.indexOf("=");
    if (separator < 1) throw new Error("--field must use name=value");
    return [value.slice(0, separator), value.slice(separator + 1)];
  });
  const names = fields.map(([name]) => name);
  if (new Set(names).size !== names.length) throw new Error("workflow fields must be unique");
  return fields;
}

function optionalTarget(args: Map<string, string[]>) {
  const targetRepository = optionalSingle(args, "target-repo");
  const itemNumber = optionalSingle(args, "item-number");
  return {
    ...(targetRepository ? { targetRepository } : {}),
    ...(itemNumber ? { itemNumber: positiveInteger(itemNumber, "item number") } : {}),
  };
}

function optionalSingle(args: Map<string, string[]>, name: string): string {
  const values = args.get(name) ?? [];
  if (values.length > 1) throw new Error(`--${name} may be provided at most once`);
  return values[0]?.trim() ?? "";
}

function assertOnlyOptions(args: Map<string, string[]>, allowed: readonly string[]): void {
  const allowedOptions = new Set(allowed);
  const unknown = [...args.keys()].filter((name) => !allowedOptions.has(name));
  if (unknown.length > 0) throw new Error(`unknown option: --${unknown[0]}`);
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function optionalPositiveInteger(value: readonly string[] | undefined, label: string) {
  if (!value) return undefined;
  if (value.length !== 1) throw new Error(`${label} must be provided once`);
  return positiveInteger(value[0]!, label);
}
