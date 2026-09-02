
## Execution receipt

Every final output must contain exactly one claims frame:

```text
---BEGIN EXECUTION_RECEIPT_CLAIMS_V1---
{"schemaVersion":"ExecutionReceiptClaimsV1",...}
---END EXECUTION_RECEIPT_CLAIMS_V1---
```

The JSON must have exactly these top-level keys:
`schemaVersion`, `objective`, `repository`, `checks`, `observations`,
`conclusions`, `unresolvedConditions`, `warnings`, and `terminal`.

Bind `objective` by copying `objectiveId`, `revision`, `objectiveHash`, and
`criteriaHash` VERBATIM from the issue document `spec`, which is the
ObjectiveEnvelopeV1 the control plane installed. Read that document; those four
values exist only there. Do not substitute the Paperclip issue id or identifier
for `objectiveId`, do not add keys to `objective`, and never emit `null` for a
value you did not find — a receipt that cannot prove which objective revision it
was built against is rejected, and the work is stranded.

Emit EXACTLY the shape below. These key names ARE the contract, not a
description of it: `additionalProperties` is false everywhere, so an extra key
rejects the whole receipt, and every hash is `sha256:` followed by 64 lowercase
hex characters — a bare digest is invalid.

```json
{
  "schemaVersion": "ExecutionReceiptClaimsV1",
  "objective": {"objectiveId": "ZEI-1", "revision": 1, "objectiveHash": "sha256:...", "criteriaHash": "sha256:..."},
  "repository": {
    "baseCommit": "<sha>", "headCommit": "<sha>", "branch": "<branch>",
    "diffHash": "sha256:...",
    "paths": [{"path": "bin/view.py", "sha256": "sha256:..."}]
  },
  "checks": [{
    "criterionId": "ZEI-1-AC-01",
    "argv": ["python3", "-m", "pytest", "-q"],
    "cwd": "/absolute/path",
    "exitCode": 0,
    "stdoutHash": "sha256:...",
    "stderrHash": "sha256:..."
  }],
  "observations": [], "conclusions": [], "unresolvedConditions": [], "warnings": [],
  "terminal": {"status": "ready_for_review", "stopReason": "<short reason>"}
}
```

`criterionId` is the objective's exact criterion id such as `ZEI-1-AC-01`, never
the requirement text. A `paths` entry carries only `path` and `sha256`; no
`status`. `terminal` carries only `status` — one of `ready_for_review`,
`blocked`, `failed`, `cancelled` — and `stopReason`. The Paperclip disposition
is recorded through the native stage, never inside this frame.

The receipt is admissible only when the goal gate recorded a verified
`goal.complete` for this run.

## Disposition

Choose the native disposition that matches the receipt. For work ready for the
configured review path, request `in_review`; for blocked, failed, or cancelled
work, record the supported disposition and reason. Then read the issue back and
confirm that it has a valid next action. Do not manually change assignees,
review policy, execution state, stage participants, or reviewer decisions.
