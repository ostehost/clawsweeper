export const COMMENT_ROUTER_LEDGER_COMMAND_LIMIT = 1_000;

const UNRESOLVED_MERGE_RECEIPTS = new Set(["attempted", "accepted", "unknown"]);
const DISPATCH_ACTIONS = new Set(["dispatch_clawsweeper", "dispatch_repair", "dispatch_assist"]);
const DURABLE_DISPATCH_STATUSES = new Set(["claimed", "waiting", "active"]);

type JsonObject = Record<string, unknown>;

export function isProtectedCommentRouterLedgerCommand(value: unknown): boolean {
  if (!isObject(value)) return false;
  const status = String(value.status ?? "");
  const actions = Array.isArray(value.actions) ? value.actions : [];
  if (
    status === "waiting" &&
    actions.some(
      (action) =>
        isObject(action) &&
        action.action === "merge" &&
        action.status === "waiting" &&
        UNRESOLVED_MERGE_RECEIPTS.has(String(action.merge_mutation_status ?? "")),
    )
  ) {
    return true;
  }
  if (status !== "claimed" && status !== "waiting") return false;
  return actions.some(
    (action) =>
      isObject(action) &&
      DISPATCH_ACTIONS.has(String(action.action ?? "")) &&
      DURABLE_DISPATCH_STATUSES.has(String(action.status ?? "")),
  );
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
