import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_ID_MAX,
  CLIENT_ID_MIN,
  MAX_PEERS_DEFAULT,
  MAX_SIGNAL_AGE_MS,
  MAX_SIGNAL_QUEUE,
  PEER_STALE_MS,
  constantTimeEqual,
  sanitizeClientId
} from "../src/index.js";

test("named limits stay the stable numbers", () => {
  assert.equal(PEER_STALE_MS, 12000);
  assert.equal(MAX_PEERS_DEFAULT, 12);
  assert.equal(MAX_SIGNAL_QUEUE, 200);
  assert.equal(MAX_SIGNAL_AGE_MS, 45000);
  assert.equal(CLIENT_ID_MIN, 8);
  assert.equal(CLIENT_ID_MAX, 48);
});

test("sanitizeClientId trims and keeps 8 to 48 url-safe characters", () => {
  assert.equal(sanitizeClientId("  client-ada  "), "client-ada");
  assert.equal(sanitizeClientId("client_ada"), "client_ada");
  assert.equal(sanitizeClientId("12345678"), "12345678");
  assert.equal(sanitizeClientId("a".repeat(48)), "a".repeat(48));
});

test("sanitizeClientId slices to 48 before the pattern test", () => {
  assert.equal(sanitizeClientId("a".repeat(60)), "a".repeat(48));
  assert.equal(sanitizeClientId("a".repeat(48) + "!"), "a".repeat(48));
  assert.equal(sanitizeClientId(" " + "b".repeat(48) + " "), "b".repeat(48));
});

test("sanitizeClientId rejects short, empty, and illegal characters", () => {
  assert.equal(sanitizeClientId(""), "");
  assert.equal(sanitizeClientId("   "), "");
  assert.equal(sanitizeClientId("short"), "");
  assert.equal(sanitizeClientId("1234567"), "");
  assert.equal(sanitizeClientId("!aaaaaaa"), "");
  assert.equal(sanitizeClientId("client ada"), "");
  assert.equal(sanitizeClientId("client.ada"), "");
});

test("sanitizeClientId rejects a non-string", () => {
  assert.equal(sanitizeClientId(undefined), "");
  assert.equal(sanitizeClientId(null), "");
  assert.equal(sanitizeClientId(12345678), "");
  assert.equal(sanitizeClientId({ id: "client-ada" }), "");
});

test("constantTimeEqual is true for equal strings", () => {
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual("a", "a"), true);
  assert.equal(constantTimeEqual("example-key", "example-key"), true);
  assert.equal(constantTimeEqual("peer-hold", "peer-hold"), true);
});

test("constantTimeEqual is false for unequal strings", () => {
  assert.equal(constantTimeEqual("a", "b"), false);
  assert.equal(constantTimeEqual("a", "aa"), false);
  assert.equal(constantTimeEqual("aa", "a"), false);
  assert.equal(constantTimeEqual("ab", "a"), false);
  assert.equal(constantTimeEqual("hello", "hello!"), false);
  assert.equal(constantTimeEqual("hello!", "hello"), false);
  assert.equal(constantTimeEqual("abcdef", "abcdeg"), false);
  assert.equal(constantTimeEqual("example-key", "example-key!"), false);
  assert.equal(constantTimeEqual("example-key", ""), false);
});

test("constantTimeEqual rejects a non-string", () => {
  assert.throws(() => constantTimeEqual("a", 1), TypeError);
  assert.throws(() => constantTimeEqual(1, "a"), TypeError);
  assert.throws(() => constantTimeEqual(null, "a"), TypeError);
  assert.throws(() => constantTimeEqual(undefined, undefined), TypeError);
});
