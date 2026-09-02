"use strict";
// Execute a plan: snapshot -> allowlisted write -> exact readback -> receipt.
//
// The order is the point. Nothing here believes a status code; `api.mutate`
// re-GETs the object and compares semantically, and a write whose fields did
// not land raises even though the server answered 200.
//
// APPLY IS ORDERED AND FAIL-FAST. On the first failed action it stops, writes a
// receipt covering what did land, and leaves the rest unapplied. A half-applied
// plan with a receipt is recoverable; a plan that ploughed on past a silent
// failure is not.

const { buildPlan, snapshot } = require("./plan");
const { hashValue, deepEqual, get, clone, FactoryError } = require("./util");
const { compareExecutionPolicy } = require("./semdiff");
const receipts = require("./receipts");
const { relocationGate, detectRootRelocation } = require("./preflight");

function unwrapper(action) {
  const key = action.unwrapKey;
  return (x) => (key && x && typeof x === "object" && x[key] !== undefined ? x[key] : x);
}

async function applyPlan(api, cfg, plan, { expectedHash, dryRun = false, allowRelocate = false } = {}) {
  if (expectedHash && expectedHash !== plan.planHash) {
    throw new FactoryError(
      "plan hash mismatch: the live state or the config changed since this plan was built. " +
      "Re-run `factory plan` and review the new plan before applying.",
      { expected: expectedHash, actual: plan.planHash },
    );
  }

  // THE RELOCATION REFUSAL LIVES HERE, NOT IN bin/factory, so it cannot be
  // bypassed by a second caller. It runs before the first write and before the
  // dry-run branch: a dry run is what the operator reads to decide, so a dry
  // run that hides the relocation is worse than no dry run at all.
  const reloc = relocationGate({
    root: cfg._root, actions: plan.actions, allowRelocate,
  });
  if (!reloc.ok) {
    throw new FactoryError(`refusing to apply: ${reloc.detail}`, {
      relocation: detectRootRelocation({ root: cfg._root, actions: plan.actions }),
    });
  }

  const started = new Date().toISOString();
  const results = [];
  let failure = null;

  for (const action of plan.actions) {
    if (dryRun) {
      results.push({ id: action.id, what: action.what, status: "dry-run", body: action.body });
      continue;
    }
    try {
      if (action.kind === "create") {
        // Creates have no prior object to read back by id, so they are verified
        // by re-resolving the collection and finding the row we asked for.
        const created = await api.post(action.writePath, action.body);
        const after = await api.get(action.readPath);
        const rows = Array.isArray(after) ? after : (after?.projects ?? after?.workspaces ?? []);
        const key = action.body.name ?? action.body.cwd;
        const found = rows.find((row) => row.name === key || row.cwd === key);
        if (!found) {
          throw new FactoryError(`create returned success but the row is not present on readback`, {
            action: action.id, looked_for: key,
          });
        }
        results.push({
          id: action.id, what: action.what, status: "applied", kind: "create",
          revertible: false,
          reason_not_revertible: "deleting a created project or workspace is destructive and out of scope for rollback",
          createdId: found.id, body: action.body,
          response: created ? { ok: true } : null,
        });
      } else {
        const out = await api.mutate({
          readPath: action.readPath,
          writePath: action.writePath,
          method: action.method,
          body: action.body,
          allow: action.allow,
          expect: action.expect,
          unwrap: unwrapper(action),
          allowMissingBefore: action.allowMissingBefore ?? false,
        });
        const existedBefore = out.before !== null;
        results.push({
          id: action.id, what: action.what, status: "applied", kind: action.kind,
          revertible: existedBefore,
          reason_not_revertible: existedBefore ? null : "the upsert created a document or instruction file; deletion is destructive and out of scope for rollback",
          readPath: action.readPath,
          writePath: action.writePath,
          method: action.method,
          unwrapKey: action.unwrapKey ?? null,
          allow: action.allow,
          body: action.body,
          before: action.before,
          after: action.after,
          // The exact pre-write object, for rollback. Not a summary — the values
          // rollback will write back must come from what was actually observed.
          // An action may declare `restore` itself when the write body and the
          // readback use DIFFERENT field names (document upserts: body vs
          // latestBody), where the generic allow∩before derivation would drop
          // the prior content entirely.
          restore: existedBefore
            ? (action.restore ?? Object.fromEntries(action.allow.filter((k) => get(out.before, k) !== undefined).map((k) => [k, get(out.before, k)])))
            : null,
          // Carried into the receipt so rollback can restore through the
          // action's declared mutation when write/readback field names differ.
          restoreMutation: existedBefore ? (action.restoreMutation ?? null) : null,
          readback: out.after,
        });
      }
    } catch (err) {
      failure = { id: action.id, what: action.what, error: err.message, details: err.details ?? null };
      results.push({ id: action.id, what: action.what, status: "failed", error: err.message, details: err.details ?? null });
      break;
    }
  }

  const receipt = {
    id: receipts.newId("apply"),
    version: 1,
    kind: "apply",
    planHash: plan.planHash,
    configFile: plan.configFile,
    company: plan.company,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    dryRun,
    outcome: failure ? "failed" : (results.length ? "applied" : "no-op"),
    actionsPlanned: plan.actions.length,
    actionsApplied: results.filter((r) => r.status === "applied").length,
    failure,
    actions: results,
    apiTrace: api.trace.slice(-200),
  };

  const stored = dryRun ? { receipt, file: null } : receipts.write(cfg._root, receipt);
  if (failure) {
    const e = new FactoryError(`apply failed at action ${failure.id}: ${failure.error}`, { receipt: receipt.id });
    e.receipt = stored.receipt;
    throw e;
  }
  return stored;
}

/**
 * Restore the exact pre-apply state recorded in a receipt, then INDEPENDENTLY
 * verify it: a second, separate GET after the restore, compared against the
 * values the receipt recorded. A rollback that trusts its own writes has the
 * same defect the rest of this system exists to eliminate.
 */
async function rollback(api, cfg, receiptId) {
  const original = receipts.read(cfg._root, receiptId);
  const applied = original.actions.filter((a) => a.status === "applied");
  const unrevertible = applied.filter((a) => a.revertible === false);
  if (unrevertible.length) {
    throw new FactoryError(
      `receipt ${receiptId} contains ${unrevertible.length} non-revertible action(s): ` +
      unrevertible.map((a) => a.id).join(", ") +
      `. Rolling back would mean deleting created objects; do that deliberately, not automatically.`,
      { unrevertible: unrevertible.map((a) => a.id) },
    );
  }
  if (!applied.length) throw new FactoryError(`receipt ${receiptId} applied nothing to roll back`);

  const started = new Date().toISOString();
  const results = [];
  let failure = null;

  // Reverse order: a later action may depend on an earlier one.
  for (const action of [...applied].reverse()) {
    try {
      const unwrap = (x) => (action.unwrapKey && x && typeof x === "object" && x[action.unwrapKey] !== undefined
        ? x[action.unwrapKey] : x);
      // An upsert whose write body and readback use different field names
      // (document upserts: body vs latestBody) declares its own restore
      // mutation. The generic path would PUT a body missing `body` — a payload
      // the server schema rejects — or verify against the wrong field names.
      if (action.restoreMutation) {
        // A declared `baseRevisionFrom` binds the restoring write to the revision
        // this apply produced. Fail closed if the receipt does not carry it:
        // restoring unbound would overwrite whatever is live now.
        let body = action.restoreMutation.body;
        const from = action.restoreMutation.baseRevisionFrom;
        if (from) {
          const base = get(action.readback, from);
          if (typeof base !== "string" || !base) {
            throw new FactoryError(
              `action ${action.id} restores under optimistic concurrency on readback field "${from}", ` +
              `but the receipt records no such value; refusing to restore unbound`,
              { action: action.id, field: from },
            );
          }
          body = { ...body, baseRevisionId: base };
        }
        await api.mutate({
          readPath: action.readPath,
          writePath: action.writePath,
          method: action.method,
          body,
          allow: action.allow,
          expect: action.restoreMutation.expect,
          unwrap,
        });
        results.push({ id: action.id, status: "restored", restored: action.restore });
        continue;
      }
      await api.mutate({
        readPath: action.readPath,
        writePath: action.writePath,
        method: action.method,
        body: action.restore,
        allow: action.allow,
        expect: Object.entries(action.restore).map(([k, v]) => ({
          path: k,
          compare: (actual) => (k === "executionPolicy"
            ? compareExecutionPolicy(v, actual).equal
            : deepEqual(actual ?? null, v ?? null)),
        })),
        unwrap,
      });
      results.push({ id: action.id, status: "restored", restored: action.restore });
    } catch (err) {
      failure = { id: action.id, error: err.message, details: err.details ?? null };
      results.push({ id: action.id, status: "failed", error: err.message });
      break;
    }
  }

  // INDEPENDENT VERIFICATION — a fresh read, not the readback mutate() already did.
  const verification = [];
  for (const action of applied) {
    const unwrap = (x) => (action.unwrapKey && x && typeof x === "object" && x[action.unwrapKey] !== undefined
      ? x[action.unwrapKey] : x);
    const live = unwrap(await api.get(action.readPath));
    if (action.restoreMutation) {
      // Server-minted identity (a document's revision id is NEW on every write,
      // including the restoring one) is not content. Verify the fields the
      // restore mutation declared, not the pre-apply identity values.
      for (const { path: k, value: v } of action.restoreMutation.expect) {
        const actual = get(live, k);
        verification.push({ action: action.id, field: k, ok: deepEqual(actual ?? null, v ?? null), expected: v, actual: actual ?? null });
      }
      continue;
    }
    for (const [k, v] of Object.entries(action.restore)) {
      const actual = get(live, k);
      const ok = k === "executionPolicy"
        ? compareExecutionPolicy(v, actual).equal
        : deepEqual(actual ?? null, v ?? null);
      verification.push({ action: action.id, field: k, ok, expected: v, actual: actual ?? null });
    }
  }
  const mismatches = verification.filter((v) => !v.ok);

  const receipt = {
    id: receipts.newId("rollback"),
    version: 1,
    kind: "rollback",
    ofReceipt: receiptId,
    ofPlanHash: original.planHash,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    outcome: failure || mismatches.length ? "failed" : "restored",
    actions: results,
    verification,
    mismatches,
    apiTrace: api.trace.slice(-200),
  };
  const stored = receipts.write(cfg._root, receipt);

  if (failure) {
    const e = new FactoryError(`rollback failed at ${failure.id}: ${failure.error}`, { receipt: receipt.id });
    e.receipt = stored.receipt;
    throw e;
  }
  if (mismatches.length) {
    const e = new FactoryError(
      `rollback wrote successfully but independent verification found ${mismatches.length} field(s) ` +
      `not matching the pre-apply snapshot`,
      { receipt: receipt.id, mismatches },
    );
    e.receipt = stored.receipt;
    throw e;
  }
  return stored;
}

module.exports = { applyPlan, buildPlan, snapshot, rollback };
