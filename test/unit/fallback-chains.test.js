"use strict";
// Where does a subscription lane go when its quota runs out?
//
// WHY THIS EXISTS. `retry.fallbackChains` led both subscription lanes with
// openrouter/z-ai/glm-5.3 at $1.73/M under a comment reading "Subscription
// lanes fall to the cheapest frontier model." Intent and implementation
// disagreed, and the disagreement was invisible: `usageAwareFallback` fires as
// the Anthropic and Codex quotas approach the 10% fail-closed reserve, the run
// still SUCCEEDS on the metered model, and nothing surfaces which lane paid.
// The operator's own observation on 2026-09-02 — "only used GLM 5.3 instead of
// 5.3-flash or any other the entire time" — is what a silent misroute looks
// like from outside.
//
// TWO FILES, NOT ONE. `omp/base.overlay.yml` reaches OMP through `--config`,
// which merges AFTER ~/.omp/agent/config.yml. The overlay therefore WINS for
// every factory run, which is the whole point of freezing it: a change to the
// operator's personal table cannot silently re-route billed factory work.
// The corollary is the trap — fixing only the personal table changes nothing
// about what the factory spends. The overlay is authoritative here and is
// asserted unconditionally; the personal table is asserted to agree with it
// whenever it exists on this machine.
//
// PRICES ARE READ FROM THE FILE'S OWN COMMENT TABLE, not restated here. A
// model added to a chain without a price in `modelRoles` fails the suite
// rather than passing unpriced.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "../..");
const OVERLAY = path.join(REPO, "omp/base.overlay.yml");
const GLOBAL = path.join(os.homedir(), ".omp/agent/config.yml");

// A failover exists to keep work moving when a subscription lane is spent. A
// lane that costs more than the alternatives defeats that purpose, and doing
// so silently is how the money leaves. Raising this number is a deliberate
// decision that has to be made HERE, in the open, not in a chain edit.
const FAILOVER_CEILING_USD_PER_M = 0.50;

/** Extract one top-level YAML block by name, as text. */
function block(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${name}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}

/** `zhipu: openrouter/z-ai/glm-5.3   # $1.73` -> { "openrouter/z-ai/glm-5.3": 1.73 } */
function priceTable(text) {
  const out = new Map();
  for (const line of (block(text, "modelRoles") ?? "").split("\n")) {
    const m = /^\s{2}[\w-]+:\s+([^\s#"@]+)\s+#\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, model, comment] = m;
    const price = /\$([\d.]+)/.exec(comment);
    // "sub" means a subscription seat: no per-token price, and never a
    // metered failover target.
    out.set(model, price ? Number(price[1]) : (/\bsub\b/.test(comment) ? "sub" : null));
  }
  return out;
}

/** `"anthropic/*": [a, b]` -> Map("anthropic/*" -> ["a","b"]) */
function fallbackChains(text) {
  const retry = block(text, "retry") ?? "";
  const out = new Map();
  const lines = retry.split("\n");
  const start = lines.findIndex((l) => /^\s{2}fallbackChains:\s*$/.test(l));
  if (start === -1) return out;
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,3}\S/.test(line) && !/^\s{4}/.test(line)) break;
    const m = /^\s{4}"?([^":]+)"?:\s*\[([^\]]*)\]\s*$/.exec(line);
    if (!m) continue;
    out.set(m[1], m[2].split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

const overlayText = fs.readFileSync(OVERLAY, "utf8");
const PRICES = priceTable(overlayText);
const CHAINS = fallbackChains(overlayText);

/** Lanes keyed on a provider that bills by seat, not by token. */
function subscriptionLanes(chains, prices) {
  const subPrefixes = [...prices.entries()]
    .filter(([, v]) => v === "sub")
    .map(([model]) => model.split("/")[0]);
  return [...chains.keys()].filter((k) => subPrefixes.includes(k.replace(/\/\*$/, "").split("/")[0]));
}

test("the overlay's model table is parseable and prices the models it names", () => {
  assert.ok(PRICES.size >= 6, `expected a populated price table, got ${PRICES.size}`);
  assert.equal(PRICES.get("openrouter/z-ai/glm-5.3"), 1.73);
  assert.equal(PRICES.get("openrouter/deepseek/deepseek-v4-pro-0813"), 0.48);
  assert.equal(PRICES.get("anthropic/claude-opus-5"), "sub");
});

test("the overlay declares fallback chains at all", () => {
  assert.ok(CHAINS.size >= 4, `expected fallback chains, got ${CHAINS.size}`);
  assert.ok(CHAINS.has("anthropic/*"));
  assert.ok(CHAINS.has("openai-codex/*"));
});

test("every model named in a chain carries a price — an unpriced failover cannot be judged", () => {
  const unpriced = [];
  for (const [lane, chain] of CHAINS) {
    for (const model of chain) {
      const p = PRICES.get(model);
      if (typeof p !== "number") unpriced.push(`${lane} -> ${model}`);
    }
  }
  assert.deepEqual(unpriced, [],
    "add the model to modelRoles with its $/M price before routing spend to it");
});

test("no subscription lane falls to a model above the failover ceiling", () => {
  // THE ASSERTION THE COMMENT USED TO MAKE AND THE FILE DID NOT KEEP.
  const lanes = subscriptionLanes(CHAINS, PRICES);
  assert.ok(lanes.length >= 2, `expected the subscription lanes to be found, got ${lanes}`);
  const over = [];
  for (const lane of lanes) {
    const first = CHAINS.get(lane)[0];
    const price = PRICES.get(first);
    if (typeof price === "number" && price > FAILOVER_CEILING_USD_PER_M) {
      over.push(`${lane} leads with ${first} at $${price}/M`);
    }
  }
  assert.deepEqual(over, [],
    `over the $${FAILOVER_CEILING_USD_PER_M}/M ceiling. A quota-pressured run takes the FIRST ` +
    `entry, silently and successfully. Reorder the chain, or raise the ceiling in this test ` +
    `deliberately.`);
});

test("no chain anywhere leads with the code-hard model by accident", () => {
  // glm-5.3 is the deliberate `code-hard` choice. That is a reason to select
  // it on purpose, and a reason it must never be what you get by default.
  for (const lane of subscriptionLanes(CHAINS, PRICES)) {
    assert.notEqual(CHAINS.get(lane)[0], "openrouter/z-ai/glm-5.3",
      `${lane} leads with the code-hard model; that is a selection, not a failover`);
  }
});

test("each chain has a second entry, so one provider outage is not a dead end", () => {
  for (const [lane, chain] of CHAINS) {
    assert.ok(chain.length >= 2, `${lane} has ${chain.length} entry(ies)`);
  }
});

test("the frozen overlay and the personal table declare the same retry policy", () => {
  // The freeze is only worth having if the two are actually reconciled. If the
  // personal table is absent this machine has no global table to disagree with
  // — the overlay still governs every factory run, and is asserted above.
  if (!fs.existsSync(GLOBAL)) {
    assert.ok(true, `${GLOBAL} not present on this machine; the overlay governs regardless`);
    return;
  }
  const globalText = fs.readFileSync(GLOBAL, "utf8");
  const a = block(overlayText, "retry");
  const b = block(globalText, "retry");
  assert.ok(a, "the overlay has no retry block");
  assert.ok(b, "the personal table has no retry block");
  assert.equal(a, b,
    "omp/base.overlay.yml and ~/.omp/agent/config.yml disagree on retry policy. " +
    "The overlay merges AFTER the global table, so the overlay is what factory runs get: " +
    "a fix applied only to the personal table changes nothing about what the factory spends.");
});
