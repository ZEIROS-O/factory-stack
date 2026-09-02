// paperclip_receipt — how the Engineer records what it did.
//
// WHY THIS TOOL EXISTS. The execution receipt used to be a byte-exact text
// frame the Engineer had to remember to emit, wrapped around JSON it assembled
// by hand: objective hashes, base and head commits, a diff hash, a sha256 for
// every changed path. On 2026-09-02 the canary died on precisely that. The
// Engineer did the work correctly — fixed src/add.js, ran the test, left the
// test file untouched — and then wrote 500 characters of accurate prose with no
// frame in it. The Reviewer had nothing machine-readable to bind to and
// declined, which was the right call, and $1.33 bought nothing.
//
// Asking more loudly does not fix that. It lowers the failure rate and keeps
// the failure mode, because it is still a model being graded on formatting.
//
// SO THE SPLIT MOVED, and it is the same split `paperclip_review` already uses.
// The model supplies only what it is the authority on: what it observed, what
// it concluded, what is unresolved, and how it is leaving the issue. Everything
// mechanical is DERIVED HERE from the worktree and the issue's own spec
// document. A hash a model transcribes can be wrong; a hash the tool computes
// cannot be.
//
// DISCOVERY. Nested layout (<dir>/tools/<name>/index.ts), so this MUST be
// reached with `--extension`, never `--plugin-dir` — that glob is
// non-recursive and the run would die with `Unknown tool in --tools:
// paperclip_receipt`. See the paperclip_review header for the full provider
// matrix; the same trap applies here.
//
// THIS MODULE IS EXECUTED AT DISCOVERY. Anything that throws while loading it
// makes OMP drop the tool SILENTLY, and the only symptom is that same
// `Unknown tool` error. FACTORY_ROOT is five levels up; the assertion below
// turns a wrong depth into a legible message instead of a vanished tool.
//
// THIS FILE IS DELIBERATELY THIN. Validation and assembly live in
// lib/receipt-submit.js where node:test can drive them and mutate them. What is
// left here is adaptation: identity from the environment, facts from the
// worktree, hand both to the library.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const require_ = createRequire(import.meta.url);
const FACTORY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../..");

if (!existsSync(path.join(FACTORY_ROOT, "lib/receipt-submit.js"))) {
  throw new Error(
    `paperclip_receipt: FACTORY_ROOT resolved to ${FACTORY_ROOT}, which contains no ` +
      `lib/receipt-submit.js. This file must sit at ` +
      `<repo>/omp/plugins/paperclip-receipt/tools/paperclip_receipt/index.ts so that five levels up ` +
      `is the repository root. If the plugin moved, fix the depth here.`,
  );
}

const { buildClaims, writeReceiptDocument } = require_(path.join(FACTORY_ROOT, "lib/receipt-submit.js"));
const { PaperclipApi } = require_(path.join(FACTORY_ROOT, "lib/api.js"));
const { resolveObjectiveForIssue } = require_(path.join(FACTORY_ROOT, "lib/objective.js"));
const { computeChangeSet, computeDiffHash } = require_(path.join(FACTORY_ROOT, "lib/promote.js"));

const factory: CustomToolFactory = pi => ({
  name: "paperclip_receipt",
  label: "Paperclip Execution Receipt",
  description:
    "Record what you did on the CURRENT issue. Call this ONCE, as the last thing you do, before you " +
    "finish your turn — the review stage cannot proceed without it. Supply only your judgement: what " +
    "you observed, what you concluded, what remains unresolved, any warnings, the checks you ran, and " +
    "how you are leaving the issue. The tool derives the objective binding, the commits, the diff " +
    "hash and the per-file digests from the worktree itself, so you never transcribe a hash. If your " +
    "submission is malformed the tool tells you why and you can call it again.",

  parameters: pi.zod.object({
    observations: pi.zod
      .array(pi.zod.string())
      .describe("What you actually observed — the state you found, what you changed, what you saw afterwards."),
    conclusions: pi.zod
      .array(pi.zod.string())
      .describe("What you concluded from those observations. Required when leaving the issue ready_for_review."),
    unresolvedConditions: pi.zod
      .array(pi.zod.string())
      .describe("Anything you could NOT settle. An empty array is a claim that nothing is unresolved."),
    warnings: pi.zod
      .array(pi.zod.string())
      .describe("Anything the reviewer or the operator should know that is not a failure."),
    checks: pi.zod
      .array(
        pi.zod.object({
          name: pi.zod.string().describe("What was checked"),
          command: pi.zod.string().describe("The command you actually ran, verbatim"),
          exitCode: pi.zod.number().describe("Its real exit code"),
          passed: pi.zod.boolean(),
        }),
      )
      .describe("The checks you ran yourself. Report them honestly; the reviewer re-runs the acceptance commands independently."),
    terminal: pi.zod
      .object({
        status: pi.zod.enum(["ready_for_review", "blocked", "abandoned"]),
        stopReason: pi.zod.string().describe("Why you stopped, in one line."),
      })
      .describe("How you are leaving this issue. This is a disposition, and a run without one can trigger a corrective redispatch."),
  }),

  async execute(_toolCallId, params) {
    const env = process.env as Record<string, string>;
    const api = new PaperclipApi(env.PAPERCLIP_API_URL, { authToken: env.PAPERCLIP_API_KEY });
    const issue = await api.get(`/api/issues/${encodeURIComponent(env.PAPERCLIP_TASK_ID ?? "")}`);

    // Fail closed on a missing identifier, for the same reason paperclip_review
    // does: the identifier binding is the only check that catches a spec
    // document misfiled onto another issue.
    if (!issue?.identifier) {
      throw new Error(
        `paperclip_receipt: issue ${env.PAPERCLIP_TASK_ID ?? "<unset>"} carries no identifier, so the ` +
          `objective cannot be bound to it. Refusing to record a receipt against an unbound objective.`,
      );
    }
    const objective = await resolveObjectiveForIssue({
      api, issueId: issue.id, identifier: issue.identifier,
    });

    // DERIVED, NEVER SUPPLIED. This is the half that made the text frame
    // fragile, and it is exactly the half a tool can compute reliably.
    const worktree = env.PAPERCLIP_WORKSPACE_WORKTREE_PATH ?? "";
    if (!worktree) {
      throw new Error(
        "paperclip_receipt: no PAPERCLIP_WORKSPACE_WORKTREE_PATH in the environment. The receipt " +
          "records a change to a workspace, and without one there is nothing to record.",
      );
    }
    const head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const changeSet = computeChangeSet(worktree, objective.repository.baseCommit);
    const repository = {
      baseCommit: objective.repository.baseCommit,
      headCommit: head,
      branch: objective.repository.branch,
      diffHash: computeDiffHash(changeSet),
      paths: changeSet.paths,
    };

    const claims = buildClaims({ supplied: params, objective, repository });
    const { docPath, claimsHash } = await writeReceiptDocument({
      api, issueId: issue.id, runId: env.PAPERCLIP_RUN_ID ?? "", claims,
    });

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Execution receipt recorded for ${objective.objectiveId} (${claims.terminal.status}).\n` +
            `  document: ${docPath}\n` +
            `  claims hash: ${claimsHash}\n` +
            `  ${claims.repository.paths.length} changed path(s), head ${head.slice(0, 7)}\n` +
            `The review stage can now read your account of this run. You do not need to repeat any of ` +
            `it in your final message.`,
        },
      ],
    };
  },
});

export default factory;
