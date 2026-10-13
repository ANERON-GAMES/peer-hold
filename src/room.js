import { constantTimeEqual, sanitizeClientId } from "./client.js";
import {
  MAX_PEERS_DEFAULT,
  MAX_SIGNAL_AGE_MS,
  MAX_SIGNAL_QUEUE,
  PEER_STALE_MS
} from "./constants.js";

export function createRoom(overrides) {
  const room = emptyRoom();
  if (overrides == null) {
    return room;
  }
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("overrides must be an object");
  }
  if (Object.hasOwn(overrides, "peers")) {
    room.peers = copyPeers(overrides.peers);
  }
  if (Object.hasOwn(overrides, "signals")) {
    room.signals = copySignals(overrides.signals);
  }
  if (Object.hasOwn(overrides, "signalSeq")) {
    room.signalSeq = readSignalSeq(overrides.signalSeq);
  }
  if (Object.hasOwn(overrides, "hostPeerId")) {
    room.hostPeerId = readRoomString(overrides.hostPeerId, "hostPeerId");
  }
  if (Object.hasOwn(overrides, "sessionId")) {
    room.sessionId = readRoomString(overrides.sessionId, "sessionId");
  }
  if (Object.hasOwn(overrides, "sessionStartedAt")) {
    room.sessionStartedAt = readRoomString(overrides.sessionStartedAt, "sessionStartedAt");
  }
  if (Object.hasOwn(overrides, "sessionStartedMs")) {
    room.sessionStartedMs = readStartedMs(overrides.sessionStartedMs);
  }
  if (Object.hasOwn(overrides, "maxPeers")) {
    room.maxPeers = readMaxPeers(overrides.maxPeers);
  }
  return room;
}

export function emitPeerLeft(room, peerId, reason, nowMs) {
  assertRoom(room);
  if (typeof peerId !== "string" || peerId.length === 0) {
    throw new TypeError("peerId must be a non-empty string");
  }
  assertReason(reason);
  assertNow(nowMs);
  const next = cloneRoom(room);
  const seq = next.signalSeq + 1;
  next.signalSeq = seq;
  next.signals.push({
    seq,
    from: peerId,
    to: "*",
    type: "peer-left",
    payload: {
      peerId,
      reason
    },
    ts: nowMs
  });
  if (next.signals.length > MAX_SIGNAL_QUEUE) {
    next.signals.splice(0, next.signals.length - MAX_SIGNAL_QUEUE);
  }
  return next;
}

export function removePeerByClientId(room, clientId, nowMs) {
  assertRoom(room);
  if (typeof clientId !== "string") {
    throw new TypeError("clientId must be a string");
  }
  assertNow(nowMs);
  const matches = [];
  for (const id of Object.keys(room.peers)) {
    if (room.peers[id].clientId === clientId) {
      matches.push(id);
    }
  }
  if (matches.length === 0) {
    return { room, removed: [] };
  }
  const next = cloneRoom(room);
  const removed = [];
  for (const id of matches) {
    const copy = copyPeer(next.peers[id]);
    delete copy.id;
    removed.push({ id, ...copy });
    delete next.peers[id];
  }
  const hostLeft = removed.some((record) => record.id === next.hostPeerId);
  let updated = next;
  for (const record of removed) {
    updated = emitPeerLeft(updated, record.id, "rejoin", nowMs);
  }
  if (hostLeft) {
    const remaining = Object.keys(updated.peers);
    updated.hostPeerId = remaining.length === 0 ? "" : remaining[0];
  }
  return { room: updated, removed };
}

export function beginSessionIfNeeded(room, reason, nowMs, makeSessionId) {
  assertRoom(room);
  assertReason(reason);
  assertNow(nowMs);
  if (typeof makeSessionId !== "function") {
    throw new TypeError("makeSessionId must be a function");
  }
  const count = Object.keys(room.peers).length;
  if (count > 0 && room.sessionId !== "") {
    return room;
  }
  const sessionId = makeSessionId();
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  const next = cloneRoom(room);
  next.sessionId = sessionId;
  next.sessionStartedAt = new Date(nowMs).toISOString();
  next.sessionStartedMs = nowMs;
  if (count === 0) {
    next.signals = [];
    next.signalSeq = 0;
  }
  return next;
}

export function endSessionIfEmpty(room, reason) {
  assertRoom(room);
  assertReason(reason);
  if (Object.keys(room.peers).length > 0) {
    return room;
  }
  if (
    room.sessionId === "" &&
    room.sessionStartedAt === "" &&
    room.sessionStartedMs === 0 &&
    room.signals.length === 0 &&
    room.hostPeerId === ""
  ) {
    return room;
  }
  const next = cloneRoom(room);
  next.sessionId = "";
  next.sessionStartedAt = "";
  next.sessionStartedMs = 0;
  next.signals = [];
  next.hostPeerId = "";
  return next;
}

export function purgeOldSignals(room, nowMs) {
  assertRoom(room);
  assertNow(nowMs);
  const kept = [];
  for (const signal of room.signals) {
    if (signal == null || typeof signal !== "object" || Array.isArray(signal)) {
      throw new TypeError("signal must be an object");
    }
    if (isExpired(signal, nowMs)) {
      continue;
    }
    if (signal.type !== "peer-left" && !senderPresent(room.peers, signal)) {
      continue;
    }
    kept.push(signal);
  }
  const capped = kept.length > MAX_SIGNAL_QUEUE ? kept.slice(kept.length - MAX_SIGNAL_QUEUE) : kept;
  if (sameSignals(room.signals, capped)) {
    return room;
  }
  const next = cloneRoom(room);
  next.signals = capped.map((signal) => cloneSignal(signal));
  return next;
}

export function purgeStalePeers(room, nowMs) {
  assertRoom(room);
  assertNow(nowMs);
  const staleIds = [];
  for (const id of Object.keys(room.peers)) {
    if (isStalePeer(room.peers[id], nowMs)) {
      staleIds.push(id);
    }
  }
  let next = room;
  if (staleIds.length > 0) {
    next = cloneRoom(room);
    for (const id of staleIds) {
      delete next.peers[id];
    }
    for (const id of staleIds) {
      next = emitPeerLeft(next, id, "stale", nowMs);
    }
    if (!Object.hasOwn(next.peers, next.hostPeerId)) {
      const remaining = Object.keys(next.peers);
      next.hostPeerId = remaining.length === 0 ? "" : remaining[0];
    }
  }
  if (Object.keys(next.peers).length === 0) {
    const reason = staleIds.length === 0 ? "empty" : "stale_empty";
    return endSessionIfEmpty(next, reason);
  }
  return purgeOldSignals(next, nowMs);
}

export function planJoin(room, input, nowMs, makeIds) {
  assertRoom(room);
  assertNow(nowMs);
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object");
  }
  const keyError = checkKey(input.key, input.expectedKey);
  if (keyError !== null) {
    return keyError;
  }
  if (makeIds == null || typeof makeIds !== "object" || Array.isArray(makeIds)) {
    throw new TypeError("makeIds must be an object");
  }
  if (typeof makeIds.peerId !== "function") {
    throw new TypeError("makeIds.peerId must be a function");
  }

  let next = purgeStalePeers(room, nowMs);
  const clientId = sanitizeClientId(input.clientId);
  let replacedCount = 0;
  if (clientId !== "") {
    const beforeCount = Object.keys(next.peers).length;
    const removal = removePeerByClientId(next, clientId, nowMs);
    replacedCount = removal.removed.length;
    next = removal.room;
    if (beforeCount > 0 && Object.keys(next.peers).length === 0) {
      next = endSessionIfEmpty(next, "rejoin_empty");
    }
  }

  const maxPeers = resolveMaxPeers(next.maxPeers, input.maxPeers);
  if (Object.keys(next.peers).length >= maxPeers) {
    return { ok: false, error: "room_full" };
  }

  if (next === room) {
    next = cloneRoom(room);
  }
  next.maxPeers = maxPeers;

  if (Object.keys(next.peers).length === 0 || next.sessionId === "") {
    if (typeof makeIds.sessionId !== "function") {
      throw new TypeError("makeIds.sessionId must be a function");
    }
    next = beginSessionIfNeeded(next, "join", nowMs, makeIds.sessionId);
  }

  const peerId = makeIds.peerId();
  if (typeof peerId !== "string" || peerId.length === 0) {
    throw new TypeError("peerId must be a non-empty string");
  }
  if (Object.hasOwn(next.peers, peerId)) {
    throw new TypeError("peerId must not already be in the room");
  }

  const name = resolveName(input.name, peerId);
  let peer;
  if (clientId === "") {
    peer = { peerId, name, lastSeenMs: nowMs };
  } else {
    peer = { peerId, clientId, name, lastSeenMs: nowMs };
  }
  const hostValid = Object.hasOwn(next.peers, next.hostPeerId);
  next.peers[peerId] = peer;
  if (!hostValid) {
    next.hostPeerId = peerId;
  }

  const result = {
    ok: true,
    room: next,
    peerId,
    clientId,
    replacedCount,
    hostPeerId: next.hostPeerId,
    sessionId: next.sessionId
  };
  if (typeof makeIds.token === "function") {
    result.token = makeIds.token();
  }
  return result;
}

function emptyRoom() {
  return {
    peers: {},
    signals: [],
    signalSeq: 0,
    hostPeerId: "",
    sessionId: "",
    sessionStartedAt: "",
    sessionStartedMs: 0,
    maxPeers: MAX_PEERS_DEFAULT
  };
}

function cloneRoom(room) {
  assertRoom(room);
  return {
    peers: copyPeers(room.peers),
    signals: copySignals(room.signals),
    signalSeq: readSignalSeq(room.signalSeq),
    hostPeerId: readRoomString(room.hostPeerId, "hostPeerId"),
    sessionId: readRoomString(room.sessionId, "sessionId"),
    sessionStartedAt: readRoomString(room.sessionStartedAt, "sessionStartedAt"),
    sessionStartedMs: readStartedMs(room.sessionStartedMs),
    maxPeers: readMaxPeers(room.maxPeers)
  };
}

function assertRoom(room) {
  if (room == null || typeof room !== "object" || Array.isArray(room)) {
    throw new TypeError("room must be an object");
  }
  if (room.peers == null || typeof room.peers !== "object" || Array.isArray(room.peers)) {
    throw new TypeError("room.peers must be an object");
  }
  if (!Array.isArray(room.signals)) {
    throw new TypeError("room.signals must be an array");
  }
}

function assertReason(reason) {
  if (typeof reason !== "string" || reason.length === 0) {
    throw new TypeError("reason must be a non-empty string");
  }
}

function assertNow(nowMs) {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be a finite number");
  }
}

function checkKey(key, expectedKey) {
  if (typeof key !== "string" || key.length === 0) {
    return { ok: false, error: "key_required" };
  }
  if (typeof expectedKey !== "string" || !constantTimeEqual(key, expectedKey)) {
    return { ok: false, error: "invalid_key" };
  }
  return null;
}

function resolveMaxPeers(roomMax, inputMax) {
  const fromInput = readPositiveInt(inputMax);
  if (fromInput !== null) {
    return fromInput;
  }
  const fromRoom = readPositiveInt(roomMax);
  if (fromRoom !== null) {
    return fromRoom;
  }
  return MAX_PEERS_DEFAULT;
}

function resolveName(raw, seed) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^[A-Za-z0-9 _.-]{1,32}$/.test(trimmed)) {
      return trimmed;
    }
  }
  return "Guest-" + guestDigits(seed);
}

function guestDigits(seed) {
  let sum = 0;
  for (let index = 0; index < seed.length; index += 1) {
    sum = (sum + seed.charCodeAt(index)) % 1000;
  }
  return String(sum).padStart(3, "0");
}

function isExpired(signal, nowMs) {
  const ts = signal.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return false;
  }
  return nowMs - ts > MAX_SIGNAL_AGE_MS;
}

function senderPresent(peers, signal) {
  return typeof signal.from === "string" && Object.hasOwn(peers, signal.from);
}

function isStalePeer(peer, nowMs) {
  if (peer == null || typeof peer !== "object" || Array.isArray(peer)) {
    throw new TypeError("peer must be an object");
  }
  const seen = peer.lastSeenMs;
  if (typeof seen !== "number" || !Number.isFinite(seen) || seen <= 0) {
    return true;
  }
  return nowMs - seen > PEER_STALE_MS;
}

function sameSignals(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function copyPeers(peers) {
  if (peers == null || typeof peers !== "object" || Array.isArray(peers)) {
    throw new TypeError("room.peers must be an object");
  }
  const copy = {};
  for (const id of Object.keys(peers)) {
    copy[id] = copyPeer(peers[id]);
  }
  return copy;
}

function copyPeer(peer) {
  if (peer == null || typeof peer !== "object" || Array.isArray(peer)) {
    throw new TypeError("peer must be an object");
  }
  const copy = {};
  for (const key of Object.keys(peer)) {
    copy[key] = peer[key];
  }
  return copy;
}

function copySignals(signals) {
  if (!Array.isArray(signals)) {
    throw new TypeError("room.signals must be an array");
  }
  return signals.map((signal) => cloneSignal(signal));
}

function cloneSignal(signal) {
  if (signal == null || typeof signal !== "object" || Array.isArray(signal)) {
    throw new TypeError("signal must be an object");
  }
  const copy = {};
  for (const key of Object.keys(signal)) {
    copy[key] = signal[key];
  }
  if (Array.isArray(copy.payload)) {
    copy.payload = copy.payload.slice();
  } else if (copy.payload != null && typeof copy.payload === "object") {
    const payload = {};
    for (const key of Object.keys(copy.payload)) {
      payload[key] = copy.payload[key];
    }
    copy.payload = payload;
  }
  return copy;
}

function readSignalSeq(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("signalSeq must be a non-negative integer");
  }
  return value;
}

function readRoomString(value, field) {
  if (typeof value !== "string") {
    throw new TypeError(field + " must be a string");
  }
  return value;
}

function readStartedMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("sessionStartedMs must be a finite number");
  }
  return value;
}

function readMaxPeers(value) {
  const maxPeers = readPositiveInt(value);
  if (maxPeers === null) {
    throw new TypeError("maxPeers must be a positive integer");
  }
  return maxPeers;
}

function readPositiveInt(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return null;
  }
  return value;
}
