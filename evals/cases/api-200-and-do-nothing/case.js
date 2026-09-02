"use strict";
const assert = require("node:assert/strict");
const { PaperclipApi } = require("../../../lib/api");

/** A server with the documented pathology: 200 OK, field silently dropped. */
function liarServer({ persist = false } = {}) {
  const state = { name: "before" };
  return async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    if (method === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify(state) };
    }
    if (persist) Object.assign(state, JSON.parse(opts.body));
    // The pathology: success, unchanged object.
    return { ok: true, status: 200, text: async () => JSON.stringify(state) };
  };
}

module.exports = {
  async run() {
    const api = new PaperclipApi("http://x", { fetch: liarServer() });
    await assert.rejects(
      () => api.mutate({
        readPath: "/api/thing", method: "PATCH",
        body: { name: "after" }, allow: ["name"],
        expect: [{ path: "name", value: "after" }],
      }),
      (err) => {
        assert.match(err.message, /did not persist/,
          "a 200 that changed nothing must be an error, not a success");
        return true;
      },
      "mutate must never report success from a status code");

    // The same call against a server that actually persists must succeed, or
    // the guard is just refusing everything.
    const honest = new PaperclipApi("http://x", { fetch: liarServer({ persist: true }) });
    const res = await honest.mutate({
      readPath: "/api/thing", method: "PATCH",
      body: { name: "after" }, allow: ["name"],
      expect: [{ path: "name", value: "after" }],
    });
    assert.equal(res.verified, true);

    // A field outside the allowlist is refused BEFORE any write is attempted.
    let wrote = false;
    const watched = new PaperclipApi("http://x", {
      fetch: async (u, o) => { if ((o?.method ?? "GET") !== "GET") wrote = true; return { ok: true, status: 200, text: async () => "{}" }; },
    });
    await assert.rejects(() => watched.mutate({
      readPath: "/api/thing", method: "PATCH",
      body: { name: "a", secret: "b" }, allow: ["name"], expect: [],
    }), /non-allowlisted/);
    assert.equal(wrote, false, "the refusal must precede the write, not follow it");
  },
};
