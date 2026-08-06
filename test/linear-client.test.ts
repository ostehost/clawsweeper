import assert from "node:assert/strict";
import test from "node:test";

import { assertLinearReadDocument, createLinearTransport } from "../dist/linear/client.js";
import {
  FORBIDDEN_LINEAR_DOCUMENTS,
  exerciseForbiddenDocuments,
} from "../scripts/linear-proof-readonly.mjs";
import {
  PRODUCTION_LINEAR_READ_DOCUMENTS,
  RETAINED_LINEAR_MUTATION_DOCUMENTS,
} from "../scripts/linear-schema-conformance.mjs";

const READ_DOCUMENT_ERROR =
  /read-only; exactly one valid GraphQL query operation is required; mutations are disabled/i;

function successfulTransport(counters: { fetchCalls: number; sleepCalls: number }) {
  return createLinearTransport({
    token: "private-personal-key",
    endpoint: "https://private-endpoint.invalid/graphql",
    fetchImpl: (async () => {
      counters.fetchCalls += 1;
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as typeof fetch,
    sleep: async () => {
      counters.sleepCalls += 1;
    },
  });
}

test("read-only transport accepts named, fragment-backed, and ignored-token queries", async () => {
  const counters = { fetchCalls: 0, sleepCalls: 0 };
  const transport = successfulTransport(counters);
  const accepted = [
    "query NamedRead { viewer { id } }",
    "query WithFragment { viewer { ...ViewerFields } } fragment ViewerFields on User { id }",
    "\uFEFF, , # ignored tokens\r\n query IgnoredTokens { viewer { id } }",
  ];

  for (const source of accepted) {
    assert.deepEqual(await transport(source, {}), { ok: true });
  }
  assert.equal(counters.fetchCalls, accepted.length);
  assert.equal(counters.sleepCalls, 0);
});

test("every forbidden document rejects before fetch and retry sleep", async () => {
  for (const testCase of FORBIDDEN_LINEAR_DOCUMENTS) {
    const counters = { fetchCalls: 0, sleepCalls: 0 };
    const transport = successfulTransport(counters);
    await assert.rejects(() => transport(testCase.source, {}), READ_DOCUMENT_ERROR, testCase.name);
    assert.equal(counters.fetchCalls, 0, `${testCase.name}: fetch calls`);
    assert.equal(counters.sleepCalls, 0, `${testCase.name}: sleep calls`);
  }
});

test("the proof matrix exercises the production transport with zero sentinel calls", async () => {
  assert.deepEqual(await exerciseForbiddenDocuments(), {
    caseCount: FORBIDDEN_LINEAR_DOCUMENTS.length,
    rejectionCount: FORBIDDEN_LINEAR_DOCUMENTS.length,
    fetchCallCount: 0,
    sleepCallCount: 0,
  });
});

test("all exported production read documents satisfy the positive query contract", () => {
  for (const document of PRODUCTION_LINEAR_READ_DOCUMENTS) {
    assert.doesNotThrow(() => assertLinearReadDocument(document.source), document.name);
  }
});

test("all retained production mutation documents fail the positive query contract", () => {
  for (const document of RETAINED_LINEAR_MUTATION_DOCUMENTS) {
    assert.throws(
      () => assertLinearReadDocument(document.source),
      READ_DOCUMENT_ERROR,
      document.name,
    );
  }
});

test("read-boundary failures do not echo documents, variables, tokens, or endpoints", async () => {
  const privateDocumentValue = "PRIVATE_DOCUMENT_VALUE";
  const privateVariableValue = "PRIVATE_VARIABLE_VALUE";
  const privateToken = "PRIVATE_TOKEN_VALUE";
  const privateEndpoint = "https://private-endpoint.invalid/graphql";
  const transport = createLinearTransport({
    token: privateToken,
    endpoint: privateEndpoint,
    fetchImpl: (async () => {
      assert.fail("forbidden document reached fetch");
    }) as typeof fetch,
  });

  await assert.rejects(
    () =>
      transport(`mutation ${privateDocumentValue} { issueUpdate { success } }`, {
        privateVariableValue,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, READ_DOCUMENT_ERROR);
      assert.doesNotMatch(error.message, new RegExp(privateDocumentValue));
      assert.doesNotMatch(error.message, new RegExp(privateVariableValue));
      assert.doesNotMatch(error.message, new RegExp(privateToken));
      assert.doesNotMatch(error.message, /private-endpoint/);
      return true;
    },
  );
});
