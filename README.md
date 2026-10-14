# peer-hold

In one realtime room, a reconnect replaces the previous peer, a silent peer is dropped, and the signal queue forgets signals whose sender has already left.

A peer id is one connection. A client id is the device that owns that connection. The same client id joins again, the previous peer is removed, and everyone still in the room gets a `peer-left` signal with reason `rejoin`. A peer with no positive `lastSeenMs`, or one that has been quiet for more than 12 seconds, is removed with reason `stale`. Signals older than 45 seconds are dropped. Signals whose sender is no longer in the room are dropped too, except `peer-left`, which is the notice that they left. The queue never grows past 200. Callers pass the clock, the room key, and the id factories. The library returns a new room. It does not open a socket.

## Install

The package is an ES module. It needs Node.js 20 or newer. It has no runtime dependencies. The package name is `@aneron/peer-hold`. It is not published to the npm registry.

Clone this repository and run the tests:

```bash
git clone https://github.com/ANERON-GAMES/peer-hold.git
cd peer-hold
npm install
npm test
```

`npm test` runs `node --test`. `npm run lint` runs ESLint. `npm run format:check` runs Prettier.

Install it as a dependency from the git repository:

```bash
npm install github:ANERON-GAMES/peer-hold
```

```js
import { createRoom, planJoin, purgeStalePeers } from "@aneron/peer-hold";
```

Code in this repository imports the same entry point with `./src/index.js`.

## Usage

A room is a plain object. Persist the object a function returns. Pass it back on the next call. Refresh `lastSeenMs` when a peer is still there. This module does not read the clock, so the caller passes `nowMs` every time.

```js
import { createRoom, planJoin, purgeStalePeers } from "@aneron/peer-hold";

const now = 1700000000000;
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
  {
    key: "example-key",
    expectedKey: "example-key",
    clientId: "client-ada",
    name: "Ada"
  },
  now,
  makeIds
);

const bo = planJoin(
  ada.room,
  {
    key: "example-key",
    expectedKey: "example-key",
    clientId: "client-bob",
    name: "Bo"
  },
  now + 10000,
  makeIds
);

const quiet = purgeStalePeers(bo.room, now + 10000 + 12000);
```

`ada` is the first peer, so `ada.hostPeerId` is `"peer-1"` and `ada.sessionId` is `"session-1"`. `ada.room.sessionStartedAt` is `"2023-11-14T22:13:20.000Z"`. `bo.hostPeerId` stays `"peer-1"`. Bo does not take the host role.

`quiet` runs 12 seconds after Bo was last seen, which is 22 seconds after Ada was last seen. Ada is past the stale limit. Bo is exactly on it, so Bo stays. `quiet.hostPeerId` is `"peer-2"`. `quiet.signals[0]` is a `peer-left` for `"peer-1"` with reason `"stale"`. The session id is still `"session-1"`, because someone remains.

A later join with `clientId: "client-ada"` removes any peer still stored under that client id before the new peer is added. There is no default room key. `"example-key"` in the snippet is only an example of the pair the caller compares.

## API reference

All functions are pure. They do not read the clock, the network, or the filesystem. They do not mutate their arguments. A call that changes nothing returns the same room reference. A call that changes the room returns a new room. Nested peer objects, signals, and signal payloads are copied when a new room is built.

A malformed room, a bad argument type, or a bad id from a factory throws `TypeError`. The join errors `key_required`, `invalid_key`, and `room_full` are return values, not throws.

### Constants

| Export              | Value   | Meaning                                                                                         |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `PEER_STALE_MS`     | `12000` | A peer older than this is silent. A peer exactly this old stays.                                |
| `MAX_PEERS_DEFAULT` | `12`    | The cap when the room and the join input do not set one.                                        |
| `MAX_SIGNAL_QUEUE`  | `200`   | The queue keeps the newest signals, up to this many.                                            |
| `MAX_SIGNAL_AGE_MS` | `45000` | A signal with `ts > 0` older than this is dropped. A signal exactly this old stays.             |
| `CLIENT_ID_MIN`     | `8`     | The shortest client id `sanitizeClientId` keeps.                                                |
| `CLIENT_ID_MAX`     | `48`    | The longest client id `sanitizeClientId` keeps. Longer input is sliced to this before the test. |

### Room

```js
{
  peers: {
    "peer-1": {
      peerId: "peer-1",
      clientId: "client-ada",
      name: "Ada",
      lastSeenMs: 1700000000000
    }
  },
  signals: [
    {
      seq: 1,
      from: "peer-1",
      to: "*",
      type: "peer-left",
      payload: { peerId: "peer-1", reason: "rejoin" },
      ts: 1700000000000
    }
  ],
  signalSeq: 1,
  hostPeerId: "peer-1",
  sessionId: "session-1",
  sessionStartedAt: "2023-11-14T22:13:20.000Z",
  sessionStartedMs: 1700000000000,
  maxPeers: 12
}
```

| Field              | Type   | Meaning                                                                                         |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| `peers`            | object | Map from peer id to peer. Key order is insertion order. That order is the host-promotion order. |
| `signals`          | array  | Oldest first.                                                                                   |
| `signalSeq`        | number | The seq of the last signal that was appended. It does not shrink when a signal is dropped.      |
| `hostPeerId`       | string | A peer id, or `""` when the room has no host.                                                   |
| `sessionId`        | string | A caller-built id, or `""` when no session is running.                                          |
| `sessionStartedAt` | string | `new Date(nowMs).toISOString()` when the session started, or `""`.                              |
| `sessionStartedMs` | number | The `nowMs` of that start, or `0`.                                                              |
| `maxPeers`         | number | A positive integer. `createRoom()` uses `MAX_PEERS_DEFAULT`.                                    |

`clientId` is omitted on a peer when the join did not have a usable client id. Extra own fields on a peer or a signal are copied. Unknown fields on the room object itself are not kept.

To mark a peer as still present, replace that peer's `lastSeenMs` and pass the new room in:

```js
function noteSeen(room, peerId, nowMs) {
  const current = room.peers[peerId];
  if (current == null) {
    return room;
  }
  return {
    ...room,
    peers: {
      ...room.peers,
      [peerId]: { ...current, lastSeenMs: nowMs }
    }
  };
}
```

`lastSeenMs` has to be a positive finite number. `0`, a negative number, `NaN`, and a missing value are already stale.

### `sanitizeClientId(raw)`

Return a client id, or `""`.

| Argument | Type | Role                           |
| -------- | ---- | ------------------------------ |
| `raw`    | any  | The value the caller received. |

1. Not a string: `""`.
2. Trim, then slice to `CLIENT_ID_MAX` characters.
3. Shorter than `CLIENT_ID_MIN`: `""`.
4. Any character outside `A-Z`, `a-z`, `0-9`, `_`, and `-`: `""`.
5. Otherwise the sliced string.

The slice happens before the pattern test. A 49th character, even an illegal one, does not spoil a legal 48-character prefix. An illegal character inside those 48 fails the whole id. The result is case-sensitive. `"client-ada"` and `"Client-Ada"` are different ids.

### `constantTimeEqual(left, right)`

Compare two strings in one pass over the longer length.

Both arguments must be strings. Anything else throws `TypeError`.

```text
diff = length(left) XOR length(right)
for i in 0 .. max(length) - 1:
  diff = diff OR (code(left, i) XOR code(right, i))
return diff === 0
```

A missing character contributes code `0`. The loop does not return early, so a mismatch on the first character takes the same number of iterations as a mismatch on the last. Equal strings, including two empty strings, return `true`. Different lengths return `false`. The iteration count still depends on the longer length. This is a compare, not a hash.

`planJoin` uses this for the room key. It does not use it for the empty-key check. An empty key fails before the compare.

### `createRoom(overrides?)`

Return a new empty room. `overrides` may be omitted, `null`, or `undefined`. Any other non-object throws `TypeError`.

Known fields on `overrides` replace the defaults. `peers` and `signals` are copied. The caller's objects are not kept. A bad `maxPeers`, `signalSeq`, or string field throws `TypeError`. `maxPeers` must be a safe integer of at least 1. `signalSeq` must be a safe integer of at least 0.

### `emitPeerLeft(room, peerId, reason, nowMs)`

Append one `peer-left` signal and return a new room.

| Argument | Type   | Role                                     |
| -------- | ------ | ---------------------------------------- |
| `room`   | object | The current room.                        |
| `peerId` | string | A non-empty peer id. Stored as `from`.   |
| `reason` | string | A non-empty reason. Stored in `payload`. |
| `nowMs`  | number | A finite timestamp. Stored as `ts`.      |

The signal is:

```js
{
  seq,
  from: peerId,
  to: "*",
  type: "peer-left",
  payload: { peerId, reason },
  ts: nowMs
}
```

`seq` is the previous `signalSeq` plus one, and `signalSeq` becomes that seq. If the queue is longer than `MAX_SIGNAL_QUEUE` after the append, signals are dropped from the front until the length is 200. Older seq values are not reused.

### `removePeerByClientId(room, clientId, nowMs)`

Remove every peer whose `clientId` is exactly `clientId`.

| Argument   | Type   | Role                                      |
| ---------- | ------ | ----------------------------------------- |
| `room`     | object | The current room.                         |
| `clientId` | string | Compared with `===`. It is not sanitized. |
| `nowMs`    | number | Passed through to each `peer-left`.       |

The return value is `{ room, removed }`.

`removed` is the matching peers in map order. Each record is `{ id, ...peer }` where `id` is the map key. When nothing matches, `room` is the same reference and `removed` is `[]`.

For each removed peer, in that same order, the new room gets a `peer-left` with reason `"rejoin"`. If one of the removed ids is `hostPeerId`, the host becomes the first remaining key, or `""` when nobody remains. A host that was not removed stays host, even if the host id was already missing. This function does not end the session. A room with no peers and a still-set session id is left for `endSessionIfEmpty`.

### `beginSessionIfNeeded(room, reason, nowMs, makeSessionId)`

Start a session when the room has no peers, or when it has peers and no session id.

| Argument        | Type     | Role                                                                               |
| --------------- | -------- | ---------------------------------------------------------------------------------- |
| `room`          | object   | The current room.                                                                  |
| `reason`        | string   | A non-empty string. It is checked and not stored.                                  |
| `nowMs`         | number   | The start time.                                                                    |
| `makeSessionId` | function | `() => string`. Called only when a session starts. Must return a non-empty string. |

1. At least one peer, and `sessionId !== ""`: the same room. `makeSessionId` is not called.
2. At least one peer, and `sessionId === ""`: set `sessionId`, `sessionStartedAt`, and `sessionStartedMs`. Keep `signals` and `signalSeq`. This is the recover path.
3. No peers: set the same three session fields, replace `signals` with `[]`, and set `signalSeq` to `0`. This happens even when the empty room already had a session id.

`sessionStartedAt` is `new Date(nowMs).toISOString()`.

### `endSessionIfEmpty(room, reason)`

Clear the session when nobody is left.

| Argument | Type   | Role                                              |
| -------- | ------ | ------------------------------------------------- |
| `room`   | object | The current room.                                 |
| `reason` | string | A non-empty string. It is checked and not stored. |

If any peer remains, the same room is returned.

If no peer remains, and `sessionId`, `sessionStartedAt`, `sessionStartedMs`, `signals`, and `hostPeerId` are already empty, the same room is returned.

Otherwise a new room is returned with those fields cleared: `sessionId` `""`, `sessionStartedAt` `""`, `sessionStartedMs` `0`, `signals` `[]`, `hostPeerId` `""`. `signalSeq` is left as it was. The next empty `beginSessionIfNeeded` resets it.

### `purgeOldSignals(room, nowMs)`

Drop signals the room no longer needs, then cap the queue.

| Argument | Type   | Role              |
| -------- | ------ | ----------------- |
| `room`   | object | The current room. |
| `nowMs`  | number | The clock.        |

A signal is dropped when either of these is true:

1. `ts` is a finite number greater than `0`, and `nowMs - ts > MAX_SIGNAL_AGE_MS`. A `ts` of `0`, a negative `ts`, or a missing `ts` is not aged out.
2. `type` is not `"peer-left"`, and `from` is not a key of `peers`.

`peer-left` is kept when the sender has already left. It is still dropped when it is older than the age limit. After those filters, if more than `MAX_SIGNAL_QUEUE` signals remain, the front of the queue is dropped. `signalSeq` does not change. When every signal stays, the same room is returned.

### `purgeStalePeers(room, nowMs)`

Remove silent peers, fix the host, then either end the session or purge signals.

| Argument | Type   | Role              |
| -------- | ------ | ----------------- |
| `room`   | object | The current room. |
| `nowMs`  | number | The clock.        |

A peer is stale when `lastSeenMs` is missing, not a finite number, not greater than `0`, or `nowMs - lastSeenMs > PEER_STALE_MS`.

Stale peers are removed in map order. Each removal appends a `peer-left` with reason `"stale"`. If `hostPeerId` is no longer a key, it becomes the first remaining key, or `""`. A host that is still present stays host, including when an earlier peer was the one removed.

Then:

1. No peers were stale, and the room was already empty: `endSessionIfEmpty(room, "empty")`.
2. The last peers were removed as stale: `endSessionIfEmpty(room, "stale_empty")`. Ending the session clears the queue, including the `peer-left` signals just appended.
3. Someone remains: `purgeOldSignals`. Offers and answers from the peers who just left are dropped. Their `peer-left` signals stay, unless the age rule drops them.

### `planJoin(room, input, nowMs, makeIds)`

Decide whether a peer may enter, and return the next room when they may.

```js
input = {
  key,
  expectedKey,
  clientId,
  name,
  maxPeers
};
```

`clientId`, `name`, and `maxPeers` may be omitted.

```js
makeIds = {
  peerId,
  sessionId,
  token
};
```

`peerId` is required. `sessionId` is required only when this join starts a session. `token` is optional. Each is a zero-argument function.

The checks run in this order. The first failure wins.

1. `key` is not a non-empty string: `{ ok: false, error: "key_required" }`. The key is not trimmed. `" "` is not empty.
2. `expectedKey` is not a string, or `constantTimeEqual(key, expectedKey)` is false: `{ ok: false, error: "invalid_key" }`.
3. `purgeStalePeers` runs on a copy.
4. When `sanitizeClientId(input.clientId)` is not `""`, `removePeerByClientId` removes the previous peers for that client. `replacedCount` is how many were removed. When that removal leaves the room empty, `endSessionIfEmpty(room, "rejoin_empty")` runs. A client id that sanitizes to `""` does not replace anyone and is not stored on the new peer.
5. The peer count is at least the cap: `{ ok: false, error: "room_full" }`. The cap is `input.maxPeers` when that is a safe integer of at least 1, otherwise `room.maxPeers` when that is, otherwise `MAX_PEERS_DEFAULT`. A rejected join does not return a room. The caller's room is unchanged, including any stale peers this attempt would have removed.
6. The room is empty or `sessionId === ""`: `beginSessionIfNeeded(room, "join", nowMs, makeIds.sessionId)`.
7. `makeIds.peerId()` must return a non-empty string that is not already a key. The peer is added with `lastSeenMs` set to `nowMs`.
8. When `hostPeerId` is not a current key, it becomes the new peer id. A valid host is not replaced by the joiner.
9. When `makeIds.token` is a function, it is called and the return value is placed on the result as `token`. It is not written onto the peer, the room, or a signal.

On success the result is:

| Field           | Meaning                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| `ok`            | `true`.                                                                              |
| `room`          | The next room, including the new peer and the new `maxPeers` when the input set one. |
| `peerId`        | The id from `makeIds.peerId()`.                                                      |
| `clientId`      | The sanitized client id, or `""`.                                                    |
| `replacedCount` | How many peers step 4 removed. A peer already removed as stale counts as `0`.        |
| `hostPeerId`    | `room.hostPeerId` after the join.                                                    |
| `sessionId`     | `room.sessionId` after the join.                                                     |
| `token`         | Present only when `makeIds.token` is a function.                                     |

Factories are called only after the join is accepted, and only the ones this join needs. The order is `sessionId` (when a session starts), then `peerId`, then `token`.

`name` is trimmed and kept when it matches `/^[A-Za-z0-9 _.-]{1,32}$/`. Otherwise the name is `"Guest-"` plus three digits. The digits are the sum of the new peer id's UTF-16 code units, modulo 1000, padded with zeros. `"peer-1"` is `"Guest-522"`. `"peer-2"` is `"Guest-523"`.

A reconnect into a full room still fits when the previous peer for that client id was occupying a slot. The removal happens before the cap check. A different client, in a room that is already at the cap after the stale purge, gets `room_full`.

A reconnect that removes the last peer ends that session, drops the `peer-left` signal with the empty queue, and starts a new session. `replacedCount` is still the number removed. A reconnect that leaves someone else in the room keeps the session and keeps the `peer-left` signal. The host, if it was the peer who left, is the first remaining peer, chosen before the new peer is inserted, so the reconnecting client does not keep the host role.

## Design notes

The room is a value. Callers persist it. Every transition takes the previous value and a timestamp and returns the next value. That is why nothing in here reads `Date.now`, opens a socket, or stores the room. Two processes can run the same inputs and get the same room back, as long as they share the id factories' results.

The client id is the reconnect key because the peer id is one connection. The new connection needs a new peer id, or the map would collide. The old peer has to disappear, or the room would hold two connections for one client. Every peer with that client id is removed, not only the first, so a duplicate cannot survive a reconnect. The comparison is exact and case-sensitive, and it uses the sanitized id that was stored. A value that fails `sanitizeClientId` becomes `""`, is not stored, and will not match on the next join. Those peers are anonymous. They do not replace each other.

`peer-left` with reason `rejoin` tells the peers who stayed to drop the old connection. When the reconnect removes the last peer, there is nobody left to tell. The session ends, the queue is cleared, and the following `beginSessionIfNeeded` starts a fresh session with `signalSeq` 0. The caller still sees `replacedCount`. When someone stays, the signal remains and the session id does not change.

Silence is `lastSeenMs`, not a timer inside the library. The caller writes the timestamp when a peer is still connected. A missing clock sample is treated as silence on purpose: a peer that never checked in should not hold a slot or the host role. The cutoff is exclusive. Age 12000 stays. Age 12001 is dropped. The same shape is used for signals, with a longer window, and only when `ts > 0`, so a caller can store a signal that should not age.

Host promotion uses insertion order, which is `Object.keys` order for these string keys. The first peer in an empty room becomes host because the host id is missing. The next peer does not take it. A stale host, or a host removed by reconnect, is replaced by the first key that is still present. The new peer is inserted after that choice, so a reconnect does not keep the host when anyone else is still in the room. A host that is still present is not replaced just because an earlier key was removed.

The queue forgets three ways, in this order: too old, sender already gone, then too long. `peer-left` skips the sender rule and still obeys age and the cap. That is the whole point of the exception. The notice has to outlive the sender, and it should not outlive the age limit or crowd out newer signals. The cap drops from the front, so the oldest seq values go first. `signalSeq` is a counter, not an index, and it is not rewound by a purge or by ending a session. An empty room that starts a session is the only reset, and it sets the counter to 0 after clearing the queue. A recover start, peers present and no session id, keeps both the queue and the counter. Those peers may still need the signals.

The key check is first so a wrong key does not depend on who is in the room. There is no key inside the library. The caller passes the candidate and the expected value. An empty candidate is `key_required` and is not compared. Any other mismatch is `invalid_key`, including a non-string expected value. The compare itself always walks the longer string.

A failed join returns the error and no room. `purgeStalePeers` during that attempt runs on a copy and is discarded. A full room of fresh peers is unchanged. A full room of stale peers stays stale until a successful join or a direct `purgeStalePeers`. Successful joins keep the purge. Callers that want a clean room without a new peer call `purgeStalePeers` themselves.

`makeIds.token` exists so the caller can attach an auth value to the join result without this module hashing it or storing it. The result field is the only place it appears. A room round-tripped through `JSON.stringify` does not contain it. `reason` on `beginSessionIfNeeded` and `endSessionIfEmpty` is the caller's name for the transition. It must be a non-empty string, and it is not a room field. The reasons that are visible in the queue are the fixed signal reasons: `"rejoin"` and `"stale"`.

The internal reasons passed to `endSessionIfEmpty`, which are not stored, are `"empty"` when the room was already empty, `"stale_empty"` when the last peers were removed as stale, and `"rejoin_empty"` when a reconnect removed the last peer. `planJoin` passes `"join"` when it starts a session.

This module does not open sockets, store rooms, or decide who is allowed to speak beyond the key, the cap, and these replacement rules. The caller chooses the key, how peer ids are minted, and when `lastSeenMs` moves forward.

## License

Released under the MIT License. The full text is in [LICENSE](LICENSE).
