import { CLIENT_ID_MAX, CLIENT_ID_MIN } from "./constants.js";

export function sanitizeClientId(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim().slice(0, CLIENT_ID_MAX);
  if (trimmed.length < CLIENT_ID_MIN || trimmed.length > CLIENT_ID_MAX) {
    return "";
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return "";
  }
  return trimmed;
}

export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    throw new TypeError("both arguments must be strings");
  }
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    diff |= leftCode ^ rightCode;
  }
  return diff === 0;
}
