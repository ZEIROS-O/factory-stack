// paperclip-goal-guard — the Engineer's runtime witness for the native goal.
//
// WHAT THIS EXTENSION IS
//   The control plane admits an Engineer run's ready-for-review work only if
//   the run's OWN runtime proved its native goal completed against the
//   canonical objective (Contract C6/C7). This extension is that proof's
//   author. It writes exactly one kind of file — the EngineerGoalGateV1
//   record at <sessionDir>/goal-gate-<PAPERCLIP_RUN_ID>.json — and nothing
//   else: no repository mutation, no write inside the worktree, no Paperclip
//   mutation. Every decision rule lives in lib/goal-gate.js, imported here,
//   so the runtime and the control plane cannot drift.
//
// WHY THE ENGINEER CANNOT FORGE THE RECORD
//   omp/worktree-guard.js blocks every agent write tool whose target lies
//   outside the assigned worktree, while ops/omp-bwrap.sh binds
//   ~/.omp/paperclip writable. The gate lands in the session directory
//   (under ~/.omp/paperclip for dispatched runs), so this factory-owned
//   extension can write it and the Engineer model cannot.
//
// LOADING — THE TRAP THIS FILE IS SHAPED TO AVOID
//   OMP loads this module at discovery (the `--extension` flag pointing at
//   THIS directory; the loader accepts <dir>/index.ts — verified in the
//   shipped src/extensibility/extensions/loader.ts:538). Anything that throws
//   at module scope makes OMP drop the extension SILENTLY, and a dropped
//   witness looks exactly like an absent gate, which fails closed but is
//   indistinguishable from a bug. So: module scope only computes paths and
//   does a legible existence check; every fallible step (environment, spec
//   fetch, gate write) lives inside the handlers and reports through
//   pi.logger, which cannot kill the extension.
//
//   FACTORY_ROOT is three levels up (paperclip-goal-guard -> plugins -> omp
//   -> repo). The sibling paperclip-review tool is five levels deep under
//   tools/<name>/; this file is not, and the depth assertion below turns a
//   wrong depth into a legible message for whoever reads the run log.
//
// FAIL-CLOSED SEMANTICS
//   Every inability — missing run identity, an unfetchable or
//   hash-inconsistent spec, a goal that never hashes to the spec's
//   objectiveHash, a session directory that cannot be established — results
//   in NO gate or a NON-TERMINAL gate. The control plane (lib/goal-gate.js
//   assertGoalGate, lib/execution-receipt.js, lib/promote.js, lib/review.js)
//   treats absence and non-termination as disproof, so failing closed here is
//   always safe and never silently passes work.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// The factory's own modules are CommonJS; this plugin is loaded as ESM.
const require_ = createRequire(import.meta.url);
const FACTORY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

// Fail with a legible reason rather than a bare MODULE_NOT_FOUND. Either way
// OMP drops the extension silently; this message is for whoever reads the run
// log or runs the file by hand.
if (!existsSync(path.join(FACTORY_ROOT, "lib/goal-gate.js"))) {
  throw new Error(
    `paperclip-goal-guard: FACTORY_ROOT resolved to ${FACTORY_ROOT}, which contains no lib/goal-gate.js. ` +
      `This file must sit at <repo>/omp/plugins/paperclip-goal-guard/index.ts so that three levels ` +
      `up is the repository root. If the plugin moved, fix the depth here.`,
  );
}

// Unchecked boundary casts, one per CommonJS module with no type declarations:
// createRequire returns unknown, each shape below is the module's real export
// surface, and misuse fails at runtime exactly at the call site.
const goalGateModule = require_(path.join(FACTORY_ROOT, "lib/goal-gate.js")) as {
  goalObjectiveTextMatchesSpec: (args: { goalObjectiveText: string; specObjective: Record<string, unknown> }) => boolean;
  objectiveFromSpecDocument: (body: string) => Record<string, unknown>;
  continuationDecision: (args: {
    goalStatus: string; continuations: number; startedAtMs: number; nowMs: number;
    limits: unknown;
  }) => { action: "continue" | "stop"; reason: string };
  goalGateFilename: (runId: string) => string;
  DEFAULT_MAX_GOAL_CONTINUATIONS: number;
};
const apiModule = require_(path.join(FACTORY_ROOT, "lib/api.js")) as {
  PaperclipApi: new (baseUrl: string, options: { authToken?: string }) => {
    get: (path: string) => Promise<unknown>;
  };
};
const utilModule = require_(path.join(FACTORY_ROOT, "lib/util.js")) as {
  hashText: (text: string) => string;
};

// The run identity the Paperclip omp adapter supplies to the child process
// (verified in the adapter's dist/server/execute.js): PAPERCLIP_RUN_ID,
// PAPERCLIP_TASK_ID, PAPERCLIP_API_URL, PAPERCLIP_API_KEY. There is no
// session-directory variable among them, so the session directory is derived
// from the session manager instead (see sessionFacts).
const REQUIRED_ENV = {
  runId: "PAPERCLIP_RUN_ID",
  taskId: "PAPERCLIP_TASK_ID",
  apiUrl: "PAPERCLIP_API_URL",
  apiKey: "PAPERCLIP_API_KEY",
} as const;

/** The session directory and id, derived the one way that is verified on
 * BOTH event kinds: ctx.sessionManager is a ReadonlySessionManager whose
 * picked surface includes getSessionDir() and getSessionId() (verified in
 * the shipped src/session/session-manager.ts:376), and ExtensionContext
 * hands the same read-only manager to every handler. The alternative —
 * event.session_file's directory — exists only on session_stop
 * (SessionStopEvent.session_file is optional; verified in
 * src/extensibility/shared-events.ts:97) and so cannot serve goal_updated;
 * it is used only as a cross-check when present. */
function sessionFacts(
  ctx: ExtensionContext,
  eventSessionFile: string | undefined,
  eventSessionId: string | undefined,
  logger: { error: (msg: string) => void },
): { sessionDir: string; sessionId: string } | null {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();
  if (typeof sessionDir !== "string" || !sessionDir || typeof sessionId !== "string" || !sessionId) {
    logger.error(
      "paperclip-goal-guard: no session directory/id from the session manager; " +
        "writing no gate, so the control plane will refuse the run",
    );
    return null;
  }
  if (eventSessionFile && path.dirname(eventSessionFile) !== sessionDir) {
    logger.error(
      `paperclip-goal-guard: session_stop session_file ${eventSessionFile} is outside the ` +
        `session manager's directory ${sessionDir}; trusting the session manager`,
    );
  }
  if (eventSessionId && eventSessionId !== sessionId) {
    logger.error(
      `paperclip-goal-guard: session_stop session_id ${eventSessionId} differs from the session ` +
        `manager's ${sessionId}; trusting the session manager`,
    );
  }
  return { sessionDir, sessionId };
}

/** The four binding fields of a verified spec envelope, narrowed at runtime
 * rather than asserted: a spec that somehow lacks them cannot produce a
 * gate, and that fails closed downstream. */
function bindingOf(spec: Record<string, unknown>): {
  objectiveId: string; revision: number; objectiveHash: string; criteriaHash: string;
} | null {
  if (typeof spec.objectiveId !== "string" || typeof spec.revision !== "number"
    || typeof spec.objectiveHash !== "string" || typeof spec.criteriaHash !== "string") {
    return null;
  }
  return {
    objectiveId: spec.objectiveId, revision: spec.revision,
    objectiveHash: spec.objectiveHash, criteriaHash: spec.criteriaHash,
  };
}

const factory: (pi: ExtensionAPI) => void = (pi) => {
  // process.env is well-typed in practice as string|undefined record; the
  // narrowing below is the runtime check that makes this cast honest.
  const env = process.env as Record<string, string | undefined>;

  // Loud, but never a throw: the handlers below stay registered and fail
  // closed (no gate written) when the identity is incomplete.
  const missing = Object.values(REQUIRED_ENV).filter(
    (name) => typeof env[name] !== "string" || !(env[name] ?? "").trim(),
  );
  if (missing.length) {
    pi.logger.error(
      `paperclip-goal-guard: run identity is missing ${missing.join(", ")}; failing closed: ` +
        "no goal-gate record will be written and the control plane will refuse the run",
    );
  }

  // Per-attempt state. One Paperclip run is one OMP process, so this closure
  // is exactly the attempt's memory.
  const attempt = {
    spec: null as Record<string, unknown> | null, // verified ObjectiveEnvelopeV1
    specFailed: false,                            // fetch/verify already failed once
    goal: null as { id: string; objective: string; status: string } | null,
    everMismatched: false,                        // any observed goal text failed the rule
    continuations: 0,                            // continuations scheduled so far
    startedAtMs: Date.now(),                     // the attempt clock for the wall-clock bound
  };

  /** The canonical objective, fetched once from the issue's spec document and
   * proved self-consistent (verifyObjectiveHashes inside
   * objectiveFromSpecDocument). A spec that cannot be fetched or does not
   * verify is permanent for the attempt: no goal can be accepted against it,
   * so no gate is written. */
  async function ensureSpec(): Promise<Record<string, unknown> | null> {
    if (attempt.spec) return attempt.spec;
    if (attempt.specFailed) return null;
    try {
      const api = new apiModule.PaperclipApi(env.PAPERCLIP_API_URL ?? "", { authToken: env.PAPERCLIP_API_KEY });
      const doc = await api.get(`/api/issues/${encodeURIComponent(env.PAPERCLIP_TASK_ID ?? "")}/documents/spec`);
      if (!doc || typeof doc !== "object" || !("body" in doc) || typeof (doc as Record<string, unknown>).body !== "string") {
        throw new Error("spec document response carries no body");
      }
      attempt.spec = goalGateModule.objectiveFromSpecDocument((doc as Record<string, unknown>).body as string);
      return attempt.spec;
    } catch (err) {
      attempt.specFailed = true;
      const reason = err instanceof Error ? err.message : String(err);
      pi.logger.error(
        `paperclip-goal-guard: cannot accept any goal against the spec: ${reason}; ` +
          "failing closed: no goal-gate record will be written",
      );
      return null;
    }
  }

  /** Atomically write the gate record — the ONLY thing this extension writes.
   * terminal is decided by the caller; it is true only for a goal that
   * reached complete with every observed goal text matching the rule. */
  function writeGate(
    ctx: ExtensionContext,
    terminal: boolean,
    eventSessionFile?: string,
    eventSessionId?: string,
  ): void {
    if (!attempt.goal || !attempt.spec || missing.length) return;
    const binding = bindingOf(attempt.spec);
    if (!binding) {
      pi.logger.error("paperclip-goal-guard: spec envelope lacks its binding fields; writing no gate");
      return;
    }
    const facts = sessionFacts(ctx, eventSessionFile, eventSessionId, pi.logger);
    if (!facts) return;
    const gate = {
      schemaVersion: "EngineerGoalGateV1",
      runId: env.PAPERCLIP_RUN_ID,
      taskId: env.PAPERCLIP_TASK_ID,
      sessionId: facts.sessionId,
      goalId: attempt.goal.id,
      goalObjectiveHash: utilModule.hashText(attempt.goal.objective),
      objectiveId: binding.objectiveId,
      revision: binding.revision,
      objectiveHash: binding.objectiveHash,
      criteriaHash: binding.criteriaHash,
      goalStatus: attempt.goal.status,
      continuations: attempt.continuations,
      terminal,
      observedAt: new Date().toISOString(),
    };
    try {
      mkdirSync(facts.sessionDir, { recursive: true });
      const finalPath = path.join(facts.sessionDir, goalGateModule.goalGateFilename(env.PAPERCLIP_RUN_ID ?? ""));
      const tmpPath = `${finalPath}.tmp-${process.pid}`;
      writeFileSync(tmpPath, `${JSON.stringify(gate, null, 2)}\n`);
      renameSync(tmpPath, finalPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      pi.logger.error(
        `paperclip-goal-guard: could not write the goal-gate record: ${reason}; ` +
          "the control plane will refuse the run for the gate's absence",
      );
    }
  }

  // ------------------------------------------------------------ goal_updated
  //
  // Record every goal transition. THE RULE (defined once, in
  // lib/goal-gate.js): the goal's objective text must be the canonical JSON
  // of the spec envelope minus its objectiveHash member, i.e.
  // hashText(goal.objective) === spec.objectiveHash. The FIRST goal must
  // satisfy it and so must every later one; a mismatch taints the attempt
  // permanently — a run that pursued the wrong objective does not redeem
  // itself by later restating the right one.
  pi.on("goal_updated", async (event, ctx) => {
    const spec = await ensureSpec();
    if (!spec) return;
    const goal = event.goal;
    if (!goal || typeof goal.objective !== "string") {
      // A null goal (goal mode exited, goal dropped) still re-records the
      // last known state below; with no goal ever seen there is nothing to
      // witness and the control plane refuses on the gate's absence.
      if (!attempt.goal) return;
      writeGate(ctx, false);
      return;
    }
    const matches = goalGateModule.goalObjectiveTextMatchesSpec({
      goalObjectiveText: goal.objective, specObjective: spec,
    });
    if (!matches) {
      attempt.everMismatched = true;
      pi.logger.error(
        "paperclip-goal-guard: goal objective does not hash to the spec's objectiveHash; " +
          "recording a mismatched, non-terminal gate — this run cannot admit ready-for-review work",
      );
    }
    attempt.goal = { id: goal.id, objective: goal.objective, status: goal.status };
    writeGate(ctx, goal.status === "complete" && !attempt.everMismatched);
  });

  // ------------------------------------------------------------- session_stop
  //
  // While a validated goal is still active, schedule exactly ONE bounded
  // continuation per settle (returning {continue:true} schedules one; OMP
  // does not stack them). The bounds come from lib/goal-gate.js
  // continuationDecision: a hard continuation count (a constant — the
  // objective envelope cannot carry one) and a hard wall clock read from the
  // objective's own limits.wallClockMinutes when present, a conservative
  // default otherwise. Never continue for a paused, budget-limited, dropped,
  // missing, or hash-mismatched goal: those must settle so the control plane
  // sees the truth and refuses.
  pi.on("session_stop", async (event, ctx) => {
    const spec = await ensureSpec();
    if (!spec) return undefined;
    if (!attempt.goal) {
      pi.logger.error(
        "paperclip-goal-guard: the session settled with no goal ever created; writing no gate — " +
          "the control plane will refuse the run",
      );
      return undefined;
    }
    if (attempt.everMismatched) {
      writeGate(ctx, false, event.session_file, event.session_id);
      return undefined;
    }
    const decision = goalGateModule.continuationDecision({
      goalStatus: attempt.goal.status,
      continuations: attempt.continuations,
      startedAtMs: attempt.startedAtMs,
      nowMs: Date.now(),
      limits: spec.limits,
    });
    if (decision.action === "continue") {
      attempt.continuations += 1;
      writeGate(ctx, false, event.session_file, event.session_id);
      pi.logger.info(
        `paperclip-goal-guard: scheduling continuation ${attempt.continuations} of ` +
          `${goalGateModule.DEFAULT_MAX_GOAL_CONTINUATIONS}: ${decision.reason}`,
      );
      return {
        continue: true,
        additionalContext:
          "Goal gate: the native goal is still active. Continue working toward the same goal " +
          "exactly as created — do not create, restate, or replace it — and complete it with " +
          "the native goal tool once the objective is met. " + decision.reason,
      };
    }
    if (attempt.continuations > 0) {
      pi.logger.info(`paperclip-goal-guard: continuation bound reached: ${decision.reason}`);
    }
    writeGate(ctx, attempt.goal.status === "complete", event.session_file, event.session_id);
    return undefined;
  });
};

export default factory;
