import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PEERS_DEFAULT,
  MAX_SIGNAL_AGE_MS,
  MAX_SIGNAL_QUEUE,
  PEER_STALE_MS,
  beginSessionIfNeeded,
  createRoom,
  emitPeerLeft,
  endSessionIfEmpty,
  planJoin,
  purgeOldSignals,
  purgeStalePeers,
  removePeerByClientId
} from "../src/index.js";

const KEY = "example-key";
const NOW = 1700000000000;

test("createRoom builds an empty room", () => {
  const room = createRoom();
  assert.deepEqual(room, {
    peers: {},
    signals: [],
    signalSeq: 0,
    hostPeerId: "",
    sessionId: "",
    sessionStartedAt: "",
    sessionStartedMs: 0,
    maxPeers: MAX_PEERS_DEFAULT
  });
  assert.deepEqual(Object.keys(createRoom()).sort(), [
    "hostPeerId",
    "maxPeers",
    "peers",
    "sessionId",
    "sessionStartedAt",
    "sessionStartedMs",
    "signalSeq",
    "signals"
  ]);
});

test("createRoom copies overrides and does not share nested objects", () => {
  const payload = { sdp: "line" };
  const peers = {
    "peer-a": { peerId: "peer-a", name: "Ada", clientId: "client-ada", lastSeenMs: 50 }
  };
  const room = createRoom({
    peers,
    signals: [{ seq: 1, from: "peer-a", to: "*", type: "offer", payload, ts: 50 }],
    signalSeq: 1,
    hostPeerId: "peer-a",
    sessionId: "session-1",
    sessionStartedAt: "2023-11-14T22:13:20.000Z",
    sessionStartedMs: 50,
    maxPeers: 4
  });
  room.peers["peer-a"].name = "Changed";
  room.signals[0].payload.sdp = "changed";
  assert.equal(peers["peer-a"].name, "Ada");
  assert.equal(payload.sdp, "line");
  assert.equal(room.maxPeers, 4);
  assert.throws(() => createRoom([]), TypeError);
  assert.throws(() => createRoom("room"), TypeError);
});

test("a second join with the same clientId replaces the previous peer", () => {
  const calls = [];
  const factories = {
    sessionId() {
      calls.push("session");
      return "session-1";
    },
    peerId() {
      calls.push("peer");
      const n = calls.filter((name) => name === "peer").length;
      return "peer-" + String(n);
    },
    token() {
      calls.push("token");
      return "opaque-value";
    }
  };
  const first = planJoin(
    createRoom(),
    { key: KEY, expectedKey: KEY, clientId: "  client-ada  ", name: "Ada" },
    NOW,
    factories
  );
  const second = planJoin(
    first.room,
    { key: KEY, expectedKey: KEY, clientId: "client-bob", name: "Bo" },
    NOW + 1000,
    factories
  );
  const again = planJoin(
    second.room,
    { key: KEY, expectedKey: KEY, clientId: "client-ada", name: "Ada" },
    NOW + 2000,
    factories
  );

  assert.equal(first.ok, true);
  assert.equal(first.replacedCount, 0);
  assert.equal(first.peerId, "peer-1");
  assert.equal(first.clientId, "client-ada");
  assert.equal(first.hostPeerId, "peer-1");
  assert.equal(first.sessionId, "session-1");
  assert.equal(first.room.sessionStartedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(first.room.sessionStartedMs, NOW);
  assert.equal(first.token, "opaque-value");
  assert.equal(Object.hasOwn(first.room.peers["peer-1"], "token"), false);
  assert.equal(JSON.stringify(first.room).includes("opaque-value"), false);

  assert.equal(second.hostPeerId, "peer-1");
  assert.equal(second.replacedCount, 0);
  assert.deepEqual(calls, ["session", "peer", "token", "peer", "token", "peer", "token"]);

  assert.equal(again.ok, true);
  assert.equal(again.replacedCount, 1);
  assert.equal(again.peerId, "peer-3");
  assert.equal(again.hostPeerId, "peer-2");
  assert.equal(again.sessionId, "session-1");
  assert.deepEqual(Object.keys(again.room.peers), ["peer-2", "peer-3"]);
  assert.equal(again.room.peers["peer-2"].name, "Bo");
  assert.equal(again.room.peers["peer-3"].name, "Ada");
  assert.equal(again.room.peers["peer-3"].clientId, "client-ada");
  assert.equal(again.room.peers["peer-3"].lastSeenMs, NOW + 2000);
  assert.equal(Object.hasOwn(again.room.peers, "peer-1"), false);
  assert.equal(again.room.signals.length, 1);
  assert.deepEqual(again.room.signals[0], {
    seq: 1,
    from: "peer-1",
    to: "*",
    type: "peer-left",
    payload: { peerId: "peer-1", reason: "rejoin" },
    ts: NOW + 2000
  });
  assert.equal(again.room.signalSeq, 1);
  assert.equal(second.room.signals.length, 0);
  assert.equal(Object.hasOwn(second.room.peers, "peer-1"), true);
});

test("a rejoin that empties the room ends the session and starts a new one", () => {
  let sessions = 0;
  const factories = {
    sessionId() {
      sessions += 1;
      return "session-" + String(sessions);
    },
    peerId() {
      return "peer-" + String(sessions);
    }
  };
  const first = planJoin(
    createRoom(),
    { key: KEY, expectedKey: KEY, clientId: "client-ada", name: "Ada" },
    NOW,
    factories
  );
  const again = planJoin(
    first.room,
    { key: KEY, expectedKey: KEY, clientId: "client-ada", name: "Ada" },
    NOW + 50,
    factories
  );
  assert.equal(again.ok, true);
  assert.equal(again.replacedCount, 1);
  assert.equal(again.sessionId, "session-2");
  assert.equal(again.hostPeerId, "peer-2");
  assert.equal(again.room.sessionStartedMs, NOW + 50);
  assert.deepEqual(again.room.signals, []);
  assert.equal(again.room.signalSeq, 0);
  assert.deepEqual(Object.keys(again.room.peers), ["peer-2"]);
});

test("removePeerByClientId removes every match and promotes the host", () => {
  const room = createRoom({
    peers: {
      "peer-a": { peerId: "peer-a", name: "A", clientId: "client-ada", lastSeenMs: 100 },
      "peer-b": { peerId: "peer-b", name: "B", clientId: "client-ada", lastSeenMs: 100 },
      "peer-c": { peerId: "peer-c", name: "C", clientId: "client-cat", lastSeenMs: 100 }
    },
    hostPeerId: "peer-a",
    sessionId: "session-1",
    sessionStartedAt: "2023-11-14T22:13:20.000Z",
    sessionStartedMs: 100
  });
  const result = removePeerByClientId(room, "client-ada", 200);
  assert.deepEqual(
    result.removed.map((record) => record.id),
    ["peer-a", "peer-b"]
  );
  assert.equal(result.removed[0].name, "A");
  assert.equal(result.room.hostPeerId, "peer-c");
  assert.deepEqual(Object.keys(result.room.peers), ["peer-c"]);
  assert.equal(result.room.sessionId, "session-1");
  assert.equal(result.room.signals.length, 2);
  assert.equal(result.room.signals[0].type, "peer-left");
  assert.equal(result.room.signals[0].to, "*");
  assert.equal(result.room.signals[0].from, "peer-a");
  assert.equal(result.room.signals[0].payload.reason, "rejoin");
  assert.equal(result.room.signals[0].seq, 1);
  assert.equal(result.room.signals[1].from, "peer-b");
  assert.equal(result.room.signals[1].seq, 2);
  assert.equal(result.room.signalSeq, 2);
  assert.equal(room.hostPeerId, "peer-a");
  assert.equal(Object.keys(room.peers).length, 3);
});

test("removing a non-host leaves the host in place", () => {
  const room = occupied(
    {
      "peer-a": peer("peer-a", "client-ada", 100),
      "peer-b": peer("peer-b", "client-bob", 100)
    },
    "peer-a"
  );
  const result = removePeerByClientId(room, "client-bob", 150);
  assert.equal(result.room.hostPeerId, "peer-a");
  assert.deepEqual(Object.keys(result.room.peers), ["peer-a"]);
  const same = removePeerByClientId(result.room, "client-nope", 160);
  assert.equal(same.room, result.room);
  assert.deepEqual(same.removed, []);
});

test("a silent peer is dropped and the next inserted peer becomes host", () => {
  const room = occupied(
    {
      "peer-m": seen("peer-m", "client-mmm", "Em", NOW),
      "peer-z": seen("peer-z", "client-zzz", "Zed", NOW + 10000),
      "peer-a": seen("peer-a", "client-aaa", "Ay", NOW + 10000)
    },
    "peer-m"
  );
  const purged = purgeStalePeers(room, NOW + 10000 + PEER_STALE_MS);
  assert.equal(Object.hasOwn(purged.peers, "peer-m"), false);
  assert.deepEqual(Object.keys(purged.peers), ["peer-z", "peer-a"]);
  assert.equal(purged.hostPeerId, "peer-z");
  assert.equal(purged.sessionId, "session-1");
  assert.equal(purged.signals.length, 1);
  assert.equal(purged.signals[0].type, "peer-left");
  assert.equal(purged.signals[0].payload.reason, "stale");
  assert.equal(purged.signals[0].payload.peerId, "peer-m");
  assert.equal(purged.signals[0].from, "peer-m");
  assert.equal(purged.signals[0].ts, NOW + 10000 + PEER_STALE_MS);
  assert.equal(room.hostPeerId, "peer-m");
});

test("a live host stays host when an earlier peer goes stale", () => {
  const room = occupied(
    {
      "peer-a": seen("peer-a", "client-ada", "Ada", 1),
      "peer-m": seen("peer-m", "client-mmm", "Em", 50000),
      "peer-z": seen("peer-z", "client-zzz", "Zed", 50000)
    },
    "peer-z"
  );
  const purged = purgeStalePeers(room, 50000);
  assert.deepEqual(Object.keys(purged.peers), ["peer-m", "peer-z"]);
  assert.equal(purged.hostPeerId, "peer-z");
});

test("a peer at the stale boundary stays and one tick later is dropped", () => {
  const now = 100000;
  const room = occupied(
    {
      "peer-a": seen("peer-a", "client-ada", "Ada", now - PEER_STALE_MS),
      "peer-b": seen("peer-b", "client-bob", "Bo", now - PEER_STALE_MS - 1)
    },
    "peer-b"
  );
  const purged = purgeStalePeers(room, now);
  assert.deepEqual(Object.keys(purged.peers), ["peer-a"]);
  assert.equal(purged.hostPeerId, "peer-a");
  assert.equal(purged.signals[0].payload.peerId, "peer-b");
});

test("a missing or non-positive lastSeenMs is stale", () => {
  const room = occupied(
    {
      "peer-a": { peerId: "peer-a", name: "Ada", clientId: "client-ada" },
      "peer-b": seen("peer-b", "client-bob", "Bo", 0),
      "peer-c": seen("peer-c", "client-cat", "Cy", -5)
    },
    "peer-a"
  );
  const purged = purgeStalePeers(room, 5000);
  assert.equal(purged.sessionId, "");
  assert.equal(purged.hostPeerId, "");
  assert.deepEqual(purged.signals, []);
  assert.deepEqual(purged.peers, {});
});

test("an empty room ends the session", () => {
  const joined = planJoin(
    createRoom(),
    { key: KEY, expectedKey: KEY, clientId: "client-ada", name: "Ada" },
    NOW,
    once("peer-1", "session-1")
  );
  const ended = purgeStalePeers(joined.room, NOW + PEER_STALE_MS + 1);
  assert.equal(ended.sessionId, "");
  assert.equal(ended.sessionStartedAt, "");
  assert.equal(ended.sessionStartedMs, 0);
  assert.equal(ended.hostPeerId, "");
  assert.deepEqual(ended.signals, []);
  assert.deepEqual(ended.peers, {});
  assert.equal(joined.room.sessionId, "session-1");
});

test("endSessionIfEmpty keeps the room when a peer remains", () => {
  const room = occupied({ "peer-a": seen("peer-a", "client-ada", "Ada", 10) }, "peer-a");
  assert.equal(endSessionIfEmpty(room, "empty"), room);
  const cleared = endSessionIfEmpty(
    createRoom({
      sessionId: "session-1",
      sessionStartedAt: "2023-11-14T22:13:20.000Z",
      sessionStartedMs: 10,
      hostPeerId: "ghost",
      signalSeq: 7,
      signals: [
        {
          seq: 7,
          from: "ghost",
          to: "*",
          type: "peer-left",
          payload: { peerId: "ghost", reason: "stale" },
          ts: 10
        }
      ]
    }),
    "empty"
  );
  assert.equal(cleared.sessionId, "");
  assert.equal(cleared.sessionStartedAt, "");
  assert.equal(cleared.sessionStartedMs, 0);
  assert.equal(cleared.hostPeerId, "");
  assert.deepEqual(cleared.signals, []);
  assert.equal(cleared.signalSeq, 7);
  const pristine = createRoom();
  assert.equal(endSessionIfEmpty(pristine, "empty"), pristine);
  assert.equal(purgeStalePeers(pristine, 10), pristine);
});

test("removing the last peer does not end the session until asked", () => {
  const room = occupied({ "peer-a": seen("peer-a", "client-ada", "Ada", 10) }, "peer-a");
  const removed = removePeerByClientId(room, "client-ada", 20);
  assert.equal(removed.room.sessionId, "session-1");
  assert.equal(removed.room.signals.length, 1);
  assert.equal(removed.room.hostPeerId, "");
  const ended = endSessionIfEmpty(removed.room, "rejoin_empty");
  assert.equal(ended.sessionId, "");
  assert.deepEqual(ended.signals, []);
  assert.equal(ended.signalSeq, removed.room.signalSeq);
});

test("purgeOldSignals drops signals older than the age limit", () => {
  const now = 100000;
  const room = occupied({ "peer-a": seen("peer-a", "client-ada", "Ada", now) }, "peer-a", [
    signal(1, "peer-a", "offer", now - MAX_SIGNAL_AGE_MS - 1),
    signal(2, "peer-a", "offer", now - MAX_SIGNAL_AGE_MS),
    signal(3, "peer-a", "offer", 0),
    signal(4, "peer-a", "peer-left", now - MAX_SIGNAL_AGE_MS - 1)
  ]);
  const purged = purgeOldSignals(room, now);
  assert.deepEqual(
    purged.signals.map((entry) => entry.seq),
    [2, 3]
  );
  assert.equal(room.signals.length, 4);
  assert.equal(purged.signalSeq, 4);
});

test("a signal at the age boundary stays", () => {
  const now = 90000;
  const room = occupied({ "peer-a": seen("peer-a", "client-ada", "Ada", now) }, "peer-a", [
    signal(1, "peer-a", "offer", now - MAX_SIGNAL_AGE_MS)
  ]);
  assert.equal(purgeOldSignals(room, now), room);
});

test("purgeOldSignals drops signals from departed peers except peer-left", () => {
  const now = 5000;
  const room = occupied({ "peer-a": seen("peer-a", "client-ada", "Ada", now) }, "peer-a", [
    signal(1, "peer-a", "offer", now),
    signal(2, "peer-b", "answer", now),
    signal(3, "peer-b", "peer-left", now),
    signal(4, "peer-b", "offer", now - MAX_SIGNAL_AGE_MS - 1)
  ]);
  const purged = purgeOldSignals(room, now);
  assert.deepEqual(
    purged.signals.map((entry) => entry.seq),
    [1, 3]
  );
  assert.equal(purged.signals[1].type, "peer-left");
  assert.equal(purged.signals[1].from, "peer-b");
  purged.signals[0].payload.n = 99;
  assert.equal(room.signals[0].payload.n, 1);
});

test("a stale peer drops its own signals and keeps the peer-left notice", () => {
  const room = occupied(
    {
      "peer-a": seen("peer-a", "client-ada", "Ada", 1000),
      "peer-b": seen("peer-b", "client-bob", "Bo", 20000)
    },
    "peer-b",
    [signal(1, "peer-a", "offer", 20000), signal(2, "peer-b", "offer", 20000)]
  );
  const purged = purgeStalePeers(room, 20000);
  assert.equal(purged.hostPeerId, "peer-b");
  assert.deepEqual(
    purged.signals.map((entry) => entry.type),
    ["offer", "peer-left"]
  );
  assert.equal(purged.signals[0].from, "peer-b");
  assert.equal(purged.signals[1].type, "peer-left");
  assert.equal(purged.signals[1].payload.reason, "stale");
  assert.equal(purged.signals[1].from, "peer-a");
});

test("the signal queue keeps the newest 200", () => {
  const signals = [];
  for (let seq = 1; seq <= MAX_SIGNAL_QUEUE + 5; seq += 1) {
    signals.push(signal(seq, "peer-a", "offer", 10000));
  }
  const room = occupied(
    { "peer-a": seen("peer-a", "client-ada", "Ada", 10000) },
    "peer-a",
    signals,
    MAX_SIGNAL_QUEUE + 5
  );
  const purged = purgeOldSignals(room, 10000);
  assert.equal(purged.signals.length, MAX_SIGNAL_QUEUE);
  assert.equal(purged.signals[0].seq, 6);
  assert.equal(purged.signals[MAX_SIGNAL_QUEUE - 1].seq, MAX_SIGNAL_QUEUE + 5);
  assert.equal(purged.signalSeq, MAX_SIGNAL_QUEUE + 5);
  assert.equal(room.signals.length, MAX_SIGNAL_QUEUE + 5);
});

test("emitPeerLeft caps the queue from the front", () => {
  let room = createRoom();
  for (let n = 0; n < MAX_SIGNAL_QUEUE; n += 1) {
    room = emitPeerLeft(room, "peer-a", "stale", 1000 + n);
  }
  assert.equal(room.signals.length, MAX_SIGNAL_QUEUE);
  assert.equal(room.signals[0].seq, 1);
  assert.equal(room.signals[MAX_SIGNAL_QUEUE - 1].seq, MAX_SIGNAL_QUEUE);
  const before = structuredClone(room);
  const next = emitPeerLeft(room, "peer-a", "stale", 5000);
  assert.deepEqual(room, before);
  assert.equal(next.signals.length, MAX_SIGNAL_QUEUE);
  assert.equal(next.signals[0].seq, 2);
  assert.equal(next.signals[MAX_SIGNAL_QUEUE - 1].seq, MAX_SIGNAL_QUEUE + 1);
  assert.equal(next.signalSeq, MAX_SIGNAL_QUEUE + 1);
  assert.equal(next.signals[MAX_SIGNAL_QUEUE - 1].type, "peer-left");
  assert.equal(next.signals[MAX_SIGNAL_QUEUE - 1].to, "*");
});

test("planJoin rejects an empty key", () => {
  const room = createRoom();
  assert.deepEqual(planJoin(room, { expectedKey: KEY }, 10, {}), {
    ok: false,
    error: "key_required"
  });
  assert.deepEqual(planJoin(room, { key: "", expectedKey: "" }, 10, {}), {
    ok: false,
    error: "key_required"
  });
  assert.deepEqual(planJoin(room, { key: null, expectedKey: KEY }, 10, {}), {
    ok: false,
    error: "key_required"
  });
  assert.equal(room.sessionId, "");
});

test("planJoin rejects a key that does not match", () => {
  const room = createRoom();
  let called = false;
  const denied = planJoin(room, { key: "example-key", expectedKey: "example-key!" }, 10, {
    peerId() {
      called = true;
      return "peer-1";
    },
    sessionId() {
      called = true;
      return "session-1";
    }
  });
  assert.deepEqual(denied, { ok: false, error: "invalid_key" });
  assert.equal(called, false);
  assert.deepEqual(planJoin(room, { key: "example-key", expectedKey: "" }, 10, {}), {
    ok: false,
    error: "invalid_key"
  });
  assert.deepEqual(planJoin(room, { key: " ", expectedKey: "example-key" }, 10, {}), {
    ok: false,
    error: "invalid_key"
  });
});

test("planJoin rejects a full room", () => {
  const room = createRoom({ maxPeers: 1 });
  const first = planJoin(
    room,
    { key: KEY, expectedKey: KEY, clientId: "client-ada", name: "Ada" },
    5000,
    once("peer-1", "session-1")
  );
  Object.freeze(first.room);
  Object.freeze(first.room.peers);
  Object.freeze(first.room.signals);
  let called = false;
  const denied = planJoin(
    first.room,
    { key: KEY, expectedKey: KEY, clientId: "client-bob", name: "Bo" },
    5001,
    {
      peerId() {
        called = true;
        return "peer-2";
      },
      sessionId() {
        called = true;
        return "session-2";
      }
    }
  );
  assert.deepEqual(denied, { ok: false, error: "room_full" });
  assert.equal(called, false);
  assert.equal(Object.keys(first.room.peers).length, 1);
});

test("a reconnect into a full room takes the previous slot", () => {
  const first = planJoin(
    createRoom({ maxPeers: 1 }),
    { key: KEY, expectedKey: KEY, clientId: "client-ada", name: "Ada" },
    5000,
    once("peer-1", "session-1")
  );
  const again = planJoin(
    first.room,
    { key: KEY, expectedKey: KEY, clientId: "client-ada", name: "Ada" },
    5002,
    once("peer-2", "session-2")
  );
  assert.equal(again.ok, true);
  assert.equal(again.replacedCount, 1);
  assert.equal(again.peerId, "peer-2");
  assert.deepEqual(Object.keys(again.room.peers), ["peer-2"]);
  assert.equal(again.room.maxPeers, 1);
});

test("input maxPeers overrides the room cap", () => {
  const first = planJoin(
    createRoom(),
    { key: KEY, expectedKey: KEY, name: "Ada", maxPeers: 2 },
    1000,
    once("peer-1", "session-1")
  );
  assert.equal(first.room.maxPeers, 2);
  const second = planJoin(
    first.room,
    { key: KEY, expectedKey: KEY, name: "Bo" },
    1001,
    once("peer-2")
  );
  assert.equal(second.ok, true);
  const denied = planJoin(
    second.room,
    { key: KEY, expectedKey: KEY, name: "Cy" },
    1002,
    once("peer-3")
  );
  assert.deepEqual(denied, { ok: false, error: "room_full" });
  const ignored = planJoin(
    createRoom(),
    { key: KEY, expectedKey: KEY, name: "Ada", maxPeers: 0 },
    1000,
    once("peer-1", "session-1")
  );
  assert.equal(ignored.room.maxPeers, MAX_PEERS_DEFAULT);
});

test("the first peer becomes host and the second does not", () => {
  const first = planJoin(
    createRoom(),
    { key: KEY, expectedKey: KEY, clientId: "client-ada", name: "Ada" },
    NOW,
    once("peer-1", "session-1")
  );
  const second = planJoin(
    first.room,
    { key: KEY, expectedKey: KEY, clientId: "client-bob", name: "Bo" },
    NOW + 1,
    once("peer-2")
  );
  assert.equal(first.hostPeerId, "peer-1");
  assert.equal(second.hostPeerId, "peer-1");
  assert.equal(second.room.peers["peer-2"].name, "Bo");
  assert.throws(
    () =>
      planJoin(createRoom(), { key: KEY, expectedKey: KEY, name: "Ada" }, NOW, {
        peerId: () => "peer-1"
      }),
    TypeError
  );
});

test("an invalid client id does not replace anyone", () => {
  const first = planJoin(
    createRoom(),
    { key: KEY, expectedKey: KEY, clientId: "short", name: "Ada" },
    NOW,
    once("peer-1", "session-1")
  );
  const second = planJoin(
    first.room,
    { key: KEY, expectedKey: KEY, clientId: "short", name: "Bo" },
    NOW + 1,
    once("peer-2")
  );
  assert.equal(first.clientId, "");
  assert.equal(Object.hasOwn(first.room.peers["peer-1"], "clientId"), false);
  assert.equal(second.replacedCount, 0);
  assert.equal(Object.keys(second.room.peers).length, 2);
});

test("an invalid name becomes Guest plus three digits and a valid name is kept", () => {
  const guest = planJoin(
    createRoom(),
    { key: KEY, expectedKey: KEY },
    NOW,
    once("peer-1", "session-1")
  );
  assert.equal(guest.room.peers["peer-1"].name, "Guest-522");
  const named = planJoin(
    guest.room,
    { key: KEY, expectedKey: KEY, name: "  Ada Bo  " },
    NOW + 1,
    once("peer-2")
  );
  assert.equal(named.room.peers["peer-2"].name, "Ada Bo");
  const rejected = planJoin(
    named.room,
    { key: KEY, expectedKey: KEY, name: "Ada!" },
    NOW + 2,
    once("peer-3")
  );
  assert.equal(rejected.room.peers["peer-3"].name, "Guest-524");
  const longName = planJoin(
    rejected.room,
    { key: KEY, expectedKey: KEY, name: "A".repeat(33) },
    NOW + 3,
    once("peer-4")
  );
  assert.equal(longName.room.peers["peer-4"].name, "Guest-525");
  const exact = planJoin(
    longName.room,
    { key: KEY, expectedKey: KEY, name: "B".repeat(32) },
    NOW + 4,
    once("peer-5")
  );
  assert.equal(exact.room.peers["peer-5"].name, "B".repeat(32));
});

test("planJoin does not mutate the input room", () => {
  const room = createRoom();
  Object.freeze(room);
  Object.freeze(room.peers);
  Object.freeze(room.signals);
  const joined = planJoin(
    room,
    { key: KEY, expectedKey: KEY, clientId: "client-ada", name: "Ada" },
    NOW,
    once("peer-1", "session-1", "opaque-value")
  );
  assert.equal(joined.ok, true);
  assert.equal(Object.keys(room.peers).length, 0);
  assert.notEqual(joined.room, room);
  assert.equal(joined.token, "opaque-value");
  assert.deepEqual(Object.keys(joined.room.peers["peer-1"]).sort(), [
    "clientId",
    "lastSeenMs",
    "name",
    "peerId"
  ]);
});

test("beginSessionIfNeeded recovers a session without clearing signals", () => {
  const room = occupied(
    { "peer-a": seen("peer-a", "client-ada", "Ada", 10) },
    "peer-a",
    [signal(4, "peer-a", "offer", 10)],
    4
  );
  const recovered = beginSessionIfNeeded(
    { ...room, sessionId: "", sessionStartedAt: "", sessionStartedMs: 0 },
    "recover",
    NOW,
    () => "session-9"
  );
  assert.equal(recovered.sessionId, "session-9");
  assert.equal(recovered.sessionStartedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(recovered.sessionStartedMs, NOW);
  assert.equal(recovered.signalSeq, 4);
  assert.equal(recovered.signals.length, 1);
  assert.equal(recovered.signals[0].seq, 4);
});

test("beginSessionIfNeeded on an empty room clears signals and resets signalSeq", () => {
  let calls = 0;
  const room = createRoom({
    sessionId: "old",
    sessionStartedAt: "2020-01-01T00:00:00.000Z",
    sessionStartedMs: 1,
    signalSeq: 40,
    signals: [signal(40, "ghost", "peer-left", 1)]
  });
  const started = beginSessionIfNeeded(room, "join", NOW, () => {
    calls += 1;
    return "session-new";
  });
  assert.equal(calls, 1);
  assert.equal(started.sessionId, "session-new");
  assert.deepEqual(started.signals, []);
  assert.equal(started.signalSeq, 0);
  assert.equal(room.signalSeq, 40);
  assert.equal(room.signals.length, 1);
});

test("beginSessionIfNeeded does nothing when peers and a session exist", () => {
  const room = occupied({ "peer-a": seen("peer-a", "client-ada", "Ada", 10) }, "peer-a");
  let calls = 0;
  const same = beginSessionIfNeeded(room, "join", NOW, () => {
    calls += 1;
    return "other";
  });
  assert.equal(same, room);
  assert.equal(calls, 0);
});

test("the usage sample replaces a peer and drops a silent host", () => {
  let n = 0;
  const makeIds = {
    peerId() {
      n += 1;
      return "peer-" + String(n);
    },
    sessionId() {
      return "session-1";
    }
  };
  const ada = planJoin(
    createRoom(),
    { key: "example-key", expectedKey: "example-key", clientId: "client-ada", name: "Ada" },
    NOW,
    makeIds
  );
  const bo = planJoin(
    ada.room,
    { key: "example-key", expectedKey: "example-key", clientId: "client-bob", name: "Bo" },
    NOW + 10000,
    makeIds
  );
  const quiet = purgeStalePeers(bo.room, NOW + 10000 + PEER_STALE_MS);
  assert.equal(ada.hostPeerId, "peer-1");
  assert.equal(bo.hostPeerId, "peer-1");
  assert.equal(quiet.hostPeerId, "peer-2");
  assert.equal(Object.hasOwn(quiet.peers, "peer-1"), false);
  assert.equal(quiet.peers["peer-2"].name, "Bo");
  assert.equal(quiet.signals[0].payload.reason, "stale");
  assert.equal(quiet.sessionId, "session-1");
});

test("malformed arguments throw TypeError", () => {
  assert.throws(() => planJoin(null, { key: KEY, expectedKey: KEY }, 1, {}), TypeError);
  assert.throws(() => planJoin(createRoom(), null, 1, {}), TypeError);
  assert.throws(() => emitPeerLeft(createRoom(), "", "stale", 1), TypeError);
  assert.throws(() => beginSessionIfNeeded(createRoom(), "", 1, () => "s"), TypeError);
  assert.throws(() => purgeStalePeers(createRoom(), Number.NaN), TypeError);
  assert.throws(
    () =>
      planJoin(createRoom(), { key: KEY, expectedKey: KEY, name: "Ada" }, NOW, {
        peerId: () => "",
        sessionId: () => "session-1"
      }),
    /peerId/
  );
});

function peer(peerId, clientId, lastSeenMs) {
  return { peerId, name: peerId, clientId, lastSeenMs };
}

function seen(peerId, clientId, name, lastSeenMs) {
  return { peerId, clientId, name, lastSeenMs };
}

function occupied(peers, hostPeerId, signals = [], signalSeq = signals.length) {
  return createRoom({
    peers,
    hostPeerId,
    sessionId: "session-1",
    sessionStartedAt: "2023-11-14T22:13:20.000Z",
    sessionStartedMs: 10,
    signals,
    signalSeq
  });
}

function signal(seq, from, type, ts) {
  return {
    seq,
    from,
    to: "*",
    type,
    payload: { n: seq },
    ts
  };
}

function once(peerId, sessionId, token) {
  const factories = {
    peerId() {
      return peerId;
    },
    sessionId() {
      return sessionId;
    }
  };
  if (typeof token === "string") {
    factories.token = () => token;
  }
  return factories;
}
