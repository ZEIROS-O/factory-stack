"use strict";
// Canonicalization, hashing, and structural helpers.
//
// Every hash in this system (plan hash, criteria hash, diff hash, spec revision)
// is taken over CANONICAL JSON: object keys sorted, no insignificant whitespace,
// undefined dropped. Two structurally equal values must hash identically no
// matter how they were constructed or what order a server returned them in.
// Without that, a hash comparison degrades into a key-order comparison and every
// "the spec did not change" assertion silently becomes untrustworthy.

const crypto = require("node:crypto");

/** Deterministic JSON: keys sorted at every depth, `undefined` dropped. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash of a value's canonical form. Prefixed so a hash is never mistaken for a uuid. */
function hashValue(value) {
  return "sha256:" + sha256(canonical(value));
}

function hashText(text) {
  return "sha256:" + sha256(text);
}

/** Deep structural equality over JSON-ish values, order-sensitive for arrays. */
function deepEqual(a, b) {
  return canonical(a) === canonical(b);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** `get(obj, "a.b.c")` — returns undefined for any missing link. */
function get(obj, path) {
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Strip keys whose value is undefined, recursively. Server payloads carry many. */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = prune(v);
    return out;
  }
  return value;
}

class FactoryError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "FactoryError";
    this.details = details ?? null;
  }
}

module.exports = { canonical, sha256, hashValue, hashText, deepEqual, clone, get, prune, FactoryError };
