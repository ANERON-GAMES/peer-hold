import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import * as api from "../src/index.js";

test("the public surface stays the named exports", () => {
  assert.deepEqual(Object.keys(api).sort(), [
    "CLIENT_ID_MAX",
    "CLIENT_ID_MIN",
    "MAX_PEERS_DEFAULT",
    "MAX_SIGNAL_AGE_MS",
    "MAX_SIGNAL_QUEUE",
    "PEER_STALE_MS",
    "beginSessionIfNeeded",
    "constantTimeEqual",
    "createRoom",
    "emitPeerLeft",
    "endSessionIfEmpty",
    "planJoin",
    "purgeOldSignals",
    "purgeStalePeers",
    "removePeerByClientId",
    "sanitizeClientId"
  ]);
});

test("source files import only sibling modules", () => {
  for (const name of sourceNames()) {
    const source = readFileSync(new URL("../src/" + name, import.meta.url), "utf8");
    const imports = source.match(/import[\s\S]*?from "\.\/[a-z]+\.js";/g) ?? [];
    const importStarts = source.match(/\bimport\b/g) ?? [];
    assert.equal(imports.length, importStarts.length);
    for (const statement of imports) {
      assert.match(statement, /from "\.\/[a-z]+\.js";$/);
    }
    assert.equal(source.includes("node:"), false);
  }
});

test("source files do not contain comments", () => {
  for (const name of sourceNames()) {
    const source = readFileSync(new URL("../src/" + name, import.meta.url), "utf8");
    assert.equal(source.includes("//"), false);
    assert.equal(source.includes("/*"), false);
  }
});

test("source files do not read the clock, the network, or the filesystem", () => {
  const banned = [
    "Date.now",
    "Math.random",
    "fetch(",
    "node:fs",
    "node:http",
    "node:net",
    "node:crypto",
    "process.env"
  ];
  for (const name of sourceNames()) {
    const source = readFileSync(new URL("../src/" + name, import.meta.url), "utf8");
    for (const word of banned) {
      assert.equal(source.includes(word), false, name + " contains " + word);
    }
  }
});

function sourceNames() {
  return readdirSync(new URL("../src/", import.meta.url))
    .filter((name) => name.endsWith(".js"))
    .sort();
}
