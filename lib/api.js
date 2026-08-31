"use strict";
// Paperclip HTTP client with mandatory semantic readback.
//
// THE RULE THIS FILE EXISTS TO ENFORCE
//   HTTP 200 is not success. Paperclip has a confirmed class of endpoints that
//   accept a payload, silently drop fields, and return 200 with the unchanged
//   object. Two independent instances are documented:
//
//     1. `PATCH /api/agents/{id}` with `{instructionsBundle: ...}` — dropped;
//        only `agent instructions-file:put` persists.
//     2. `POST/PATCH` issue with `executionWorkspacePreference` /
//        `executionWorkspaceSettings` / `executionWorkspaceId` — deleted outright
//        when the instance flag `enableIsolatedWorkspaces` is off
//        (services/issues.js:5312, :5610, :5850), and still 200.
//
//   It is a class, not a pair of one-offs. So `mutate()` below has no mode in
//   which it reports success from a status code. Every write is followed by a
//   fresh GET and a semantic comparison, and a write whose readback does not
//   match is an error even though the server said OK.

const { FactoryError, deepEqual, clone, get } = require("./util");

const DEFAULT_TIMEOUT_MS = 15000;

class PaperclipApi {
  constructor(baseUrl, options = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    // Every request/response pair, for receipts and for test assertions.
    this.trace = [];
  }

  async request(method, path, body) {
    const url = this.baseUrl + path;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res, text;
    try {
      res = await this.fetchImpl(url, {
        method,
        signal: ac.signal,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await res.text();
    } catch (err) {
      clearTimeout(timer);
      throw new FactoryError(`${method} ${path} failed: ${err.message}`, { method, path });
    }
    clearTimeout(timer);

    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    this.trace.push({ method, path, status: res.status, at: new Date().toISOString() });

    if (!res.ok) {
      throw new FactoryError(`${method} ${path} -> HTTP ${res.status}`, {
        method, path, status: res.status, body: text.slice(0, 2000),
      });
    }
    return json;
  }

  get(path) { return this.request("GET", path); }
  post(path, body) { return this.request("POST", path, body); }
  put(path, body) { return this.request("PUT", path, body); }
  patch(path, body) { return this.request("PATCH", path, body); }

  async health() {
    return this.get("/api/health");
  }

  /**
   * The only sanctioned write path.
   *
   *   readPath   where to GET the authoritative object afterwards
   *   writePath  where to send the mutation
   *   body       the payload — MUST touch only `allow` field paths
   *   allow      allowlist of top-level body keys this mutation may set
   *   expect     [{path, value}] semantic assertions checked against the readback
   *   unwrap     optional fn to pull the object out of an envelope response
   *
   * Returns {before, after, verified:true}. Throws on any unmet expectation, so a
   * caller cannot accidentally proceed on a silently-dropped field.
   */
  async mutate({ readPath, writePath, method = "PATCH", body, allow, expect, unwrap = (x) => x }) {
    const bodyKeys = Object.keys(body ?? {});
    const illegal = bodyKeys.filter((k) => !allow.includes(k));
    if (illegal.length) {
      throw new FactoryError(
        `mutation body touches non-allowlisted fields: ${illegal.join(", ")}`,
        { allow, bodyKeys },
      );
    }

    const before = clone(unwrap(await this.get(readPath)));
    await this.request(method, writePath ?? readPath, body);
    const after = clone(unwrap(await this.get(readPath)));

    const failures = [];
    for (const { path, value, compare } of expect) {
      const actual = get(after, path);
      const ok = compare ? compare(actual, after) : deepEqual(actual, value);
      if (!ok) failures.push({ path, expected: value ?? "(custom predicate)", actual });
    }
    if (failures.length) {
      throw new FactoryError(
        `write returned success but did not persist (${failures.length} field(s)). ` +
        `This is Paperclip's 200-and-do-nothing class — see README.`,
        { writePath: writePath ?? readPath, failures, sent: body },
      );
    }
    return { before, after, verified: true };
  }
}

module.exports = { PaperclipApi, DEFAULT_TIMEOUT_MS };
