// paperclip_review — the Reviewer's ONLY write-capable tool.
//
// DISCOVERY — TWO FACTS, BOTH VERIFIED AGAINST OMP'S SHIPPED SOURCE.
//
// OMP ships its TypeScript sources under the installed package's `src/`; read
// those rather than probing the minified dist. There are THREE tool providers
// and their layouts are NOT interchangeable:
//
//   omp-plugins   <- `--extension <dir>`  scans <dir>/tools/, accepts BOTH
//                    flat files and <name>/index.ts, name from the DIRECTORY
//                    (discovery/omp-plugins.ts:248)
//   claude-plugins<- `--plugin-dir <dir>` scans <dir>/tools/*.{ts,js} ONLY —
//                    a non-recursive glob, name from the FILENAME
//                    (discovery/claude-plugins.ts:407)
//   builtin       <- ~/.omp/agent/tools, <cwd>/.omp/tools (shared global state)
//
// This tool uses the nested layout, so it MUST be reached with `--extension`.
// Under `--plugin-dir` the nested directory is invisible to the glob and the
// run dies at startup with `Unknown tool in --tools: paperclip_review`. That
// pairing is the trap; it is not an OMP limitation.
//
// The flag reaches OMP through the Paperclip adapter's `extraArgs`, which is
// the ONLY adapterConfig key that reaches the CLI. adapter-pi-local reads just
// command/model/thinking/cwd/env/timeoutSec/graceSec/instructionsFilePath/
// promptTemplate/extraArgs; `pluginDirs`, `tools`, `configFiles` and `hooks`
// are silently ignored. See the comment in factory.config.json.
//
// Renaming this directory renames the tool, and the `--tools` allowlist in
// factory.config.json must be renamed with it.
//
// THIS MODULE IS EXECUTED AT DISCOVERY, NOT MERELY READ. Anything that throws
// while loading it makes OMP drop the tool SILENTLY — the only symptom is the
// same `Unknown tool in --tools` error, which reads as "OMP cannot do this"
// rather than "this file failed to load". FACTORY_ROOT below is five levels up
// (paperclip_review -> tools -> paperclip-review -> plugins -> omp -> repo);
// it was four, which resolved to <repo>/omp, so every require below threw and
// the tool vanished without a word. The assertion under it turns that class of
// mistake into a legible message, and `factory preflight` proves real
// registration so it cannot pass unnoticed again.
//
// THIS FILE IS DELIBERATELY THIN. Every rule that decides whether work is
// approved lives in lib/review.js, where node:test can drive it directly and
// mutate it to prove the tests bite. What is left here is adaptation: pull the
// run's identity out of the environment, derive the change set from the
// worktree, hand it all to submitReview, and render the outcome. If you find
// yourself adding a decision here, it belongs in lib/review.js instead.
//
// WHAT THIS TOOL CANNOT DO, BY CONSTRUCTION
//   - review a different issue: there is no issue parameter; the target comes
//     from PAPERCLIP_TASK_ID and nothing else
//   - approve over a failing check: the disposition is derived, not accepted
//   - reach any endpoint but the current issue's assessment document and its
//     own status PATCH
//   - run the acceptance commands under its own permissions: they execute in
//     the separate read-only verifier, with no network and no credentials

import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

// The factory's own modules are CommonJS; this plugin is loaded as ESM.
const require_ = createRequire(import.meta.url);
const FACTORY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../..");

// Fail with a legible reason rather than a bare MODULE_NOT_FOUND. Either way OMP
// drops the tool silently, so this message is for whoever reads the run log or
// runs the file by hand — the machine-checkable version of this is the
// registration probe in `factory preflight`.
if (!existsSync(path.join(FACTORY_ROOT, "lib/review.js"))) {
  throw new Error(
    `paperclip_review: FACTORY_ROOT resolved to ${FACTORY_ROOT}, which contains no lib/review.js. ` +
      `This file must sit at <repo>/omp/plugins/paperclip-review/tools/paperclip_review/index.ts ` +
      `so that five levels up is the repository root. If the plugin moved, fix the depth here.`,
  );
}

const { submitReview } = require_(path.join(FACTORY_ROOT, "lib/review.js"));
const { PaperclipApi } = require_(path.join(FACTORY_ROOT, "lib/api.js"));
const { loadContract, verifyObjectiveHashes } = require_(path.join(FACTORY_ROOT, "lib/contracts.js"));
const { computeChangeSet, computeDiffHash } = require_(path.join(FACTORY_ROOT, "lib/promote.js"));
const { loadExecutionReceiptForReview } = require_(path.join(FACTORY_ROOT, "lib/execution-receipt.js"));

const VERIFIER = path.join(FACTORY_ROOT, "ops/omp-verify-bwrap.sh");

/** Run one acceptance command in the read-only verifier. Never throws: a
 *  verifier that could not run is a FAILED check, which lib/review.js records. */
function exec(file: string, args: string[], opts: Record<string, unknown> = {}) {
  return spawnSync(file, args, { encoding: "utf8", ...opts });
}

const factory: CustomToolFactory = pi => ({
  name: "paperclip_review",
  label: "Paperclip Review",
  description:
    "Submit your structured review of the CURRENT issue. Supply one verdict per acceptance criterion " +
    "(PASS / FAIL / BLOCKED / UNCERTAIN) with evidence and reasoning, plus a summary. " +
    "The tool independently executes every acceptance command in a read-only sandbox, derives the " +
    "overall verdict and the disposition from your verdicts AND those results, writes the assessment " +
    "document, and advances the native execution stage. You cannot choose the disposition directly, " +
    "cannot approve over a failing check, and cannot target another issue.",

  parameters: pi.zod.object({
    criteria: pi.zod
      .array(
        pi.zod.object({
          criterionId: pi.zod.string().describe("Exact criterion id from the objective, e.g. ZEI-1-AC-01"),
          verdict: pi.zod.enum(["PASS", "FAIL", "BLOCKED", "UNCERTAIN"]),
          reasoning: pi.zod.string().describe("Concise reasoning for this verdict"),
          evidenceRefs: pi.zod.array(pi.zod.string()).describe("What you actually inspected"),
          uncertainty: pi.zod
            .string()
            .nullable()
            .describe("Explicit uncertainty or coverage gap, or null if none"),
        }),
      )
      .describe("Exactly one entry per acceptance criterion. Missing or extra criteria are rejected."),
    summary: pi.zod
      .string()
      .describe("Summary of the review. Becomes the stage decision comment, which Paperclip requires."),
  }),

  async execute(_toolCallId, params) {
    const env = process.env as Record<string, string>;

    // The objective is read from the hash-bound envelope on disk and its hashes
    // are re-verified here. A tampered objective must not be reviewable.
    const objective = verifyObjectiveHashes(
      loadContract(path.join(FACTORY_ROOT, "contracts/objectives/ZEI-1.json"), "ObjectiveEnvelopeV1"),
    );

    const worktree = env.PAPERCLIP_WORKSPACE_WORKTREE_PATH ?? "";
    // DERIVED BY THE REVIEWER, not taken from the producer's account of its own
    // work: the assessment must bind to the change this review actually saw.
    const changeSet = computeChangeSet(worktree, objective.repository.baseCommit);
    const head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const api = new PaperclipApi(env.PAPERCLIP_API_URL, { authToken: env.PAPERCLIP_API_KEY });
    const issue = await api.get(`/api/issues/${encodeURIComponent(env.PAPERCLIP_TASK_ID ?? "")}`);
    const loadedReceipt = await loadExecutionReceiptForReview({ api, issue, objective });

    const result = await submitReview({
      env,
      api,
      objective,
      reviewerModel: env.FACTORY_REVIEWER_MODEL ?? "",
      engineerModel: env.FACTORY_ENGINEER_MODEL ?? "",
      verifierPath: VERIFIER,
      exec,
      criteria: params.criteria,
      summary: params.summary,
      changeSet: {
        baseCommit: objective.repository.baseCommit,
        headCommit: head,
        diffHash: computeDiffHash(changeSet),
        changedPaths: changeSet.paths.map((p: { path: string }) => p.path),
        paths: changeSet.paths,
      },
      executionReceipt: loadedReceipt.receipt,
      round: Number(issue.executionState?.changesRequestedCount ?? 0) + 1,
      limits: objective.limits,
    });

    const lines = [
      `disposition: ${result.disposition}${result.escalated ? " (escalated to the operator)" : ""}`,
      `overall verdict: ${result.overallVerdict}`,
      `issue status: ${result.status}`,
      "",
      "deterministic checks:",
      ...result.deterministicResults.map(
        (r: { criterionId: string; passed: boolean; exitCode: number | null }) =>
          `  ${r.passed ? "PASS" : "FAIL"}  ${r.criterionId}  (exit ${r.exitCode})`,
      ),
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        disposition: result.disposition,
        overallVerdict: result.overallVerdict,
        escalated: result.escalated,
        issueId: result.issueId,
        runId: result.runId,
      },
    };
  },
});

export default factory;
