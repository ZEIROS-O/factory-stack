"use strict";
// Snapshot the live instance, diff it against the declared desired state, and
// emit an ordered list of ACTIONS. Planning performs no writes.
//
// An action is self-describing and independently checkable:
//   readPath  the authoritative GET for this object
//   writePath/method  the mutation
//   allow     top-level body keys this action is permitted to set. `apply`
//             refuses a body touching anything else, so a planner bug cannot
//             widen a mutation's blast radius past what was reviewed.
//   expect    semantic assertions checked against a POST-WRITE readback
//   before    the live value at plan time — part of the plan hash, so applying a
//             stale plan against changed state fails instead of clobbering it.

const { hashValue, clone, get, deepEqual, FactoryError } = require("./util");
const { compareExecutionPolicy, compareWorkspaceStrategy, compareSubset } = require("./semdiff");
const { Resolver } = require("./resolve");

// Everything the factory owns inside an agent's adapterConfig. A key must be
// listed here to be written at all — `extraArgs` was missing, so the Reviewer's
// --extension/--tools flags would have been reconciled into nothing.
//
// The retired keys stay listed DELIBERATELY. adapter-pi-local reads none of
// them (nor does the server), so their live values arm nothing while reading
// exactly like a boundary. Keeping them managed is what lets a key dropped from
// the config be REMOVED from the live record rather than left behind to
// mislead the next reader.
const AGENT_MANAGED_KEYS = [
  "command", "model", "thinking", "extraArgs", "timeoutSec", "graceSec",
  // Retired: inert on this adapter, managed only so they can be cleared.
  "approvalMode", "autoApprove", "configFiles", "hooks", "tools", "pluginDirs",
];

const PROJECT_POLICY_KEYS = ["enabled", "defaultMode", "allowIssueOverride", "workspaceStrategy"];

/** Read everything the plan depends on, once, into a plain object. */
async function snapshot(api, cfg) {
  const r = new Resolver(api);
  const company = await r.company(cfg.company.name);
  const operator = await r.member(company.id, cfg.operator.memberEmail);

  const goals = {};
  for (const g of cfg.goals ?? []) goals[g.key] = await r.goal(company.id, g.titlePrefix);

  const agents = {};
  for (const a of cfg.agents) agents[a.name] = await r.agent(company.id, a.name);

  const agentInstructions = {};
  for (const a of cfg.agents) {
    if (a.instructions) agentInstructions[a.name] = await r.agentInstructions(agents[a.name].id, a.instructions.path);
  }

  const projects = {};
  for (const p of cfg.projects) {
    const live = await r.projectOrNull(company.id, p.name);
    projects[p.name] = {
      live,
      workspaces: live ? await r.projectWorkspaces(live.id) : [],
    };
  }

  const issues = {};
  const issueDocuments = {};
  for (const i of cfg.issues) {
    issues[i.identifier] = await r.issue(company.id, i.identifier);
    issueDocuments[i.identifier] = {};
    if (i.objectiveDocument) {
      issueDocuments[i.identifier][i.objectiveDocument.key] =
        await r.issueDocument(issues[i.identifier].id, i.objectiveDocument.key);
    }
  }

  const experimental = await api.get("/api/instance/settings/experimental");

  return {
    at: new Date().toISOString(),
    company, operator, goals, agents, agentInstructions, projects, issues, issueDocuments,
    experimental: experimental?.experimental ?? experimental ?? {},
    resolver: r,
  };
}

/** Desired executionPolicy with participant names resolved to live ids. */
function resolveExecutionPolicy(desired, snap) {
  if (!desired) return null;
  return {
    ...desired,
    stages: (desired.stages ?? []).map((stage) => ({
      ...stage,
      participants: (stage.participants ?? []).map((p) => {
        if (p.type === "agent") {
          const agent = snap.agents[p.agent];
          if (!agent) throw new Error(`executionPolicy references unknown agent "${p.agent}"`);
          return { type: "agent", agentId: agent.id };
        }
        return { type: "user", userId: snap.operator.userId };
      }),
    })),
  };
}

function planInstance(cfg, snap, actions) {
  const want = cfg.instance.experimental;
  const drift = Object.entries(want).filter(([k, v]) => snap.experimental?.[k] !== v);
  if (!drift.length) return;
  const body = Object.fromEntries(drift);
  actions.push({
    id: "instance:experimental",
    kind: "update",
    what: `instance experimental flags: ${drift.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    readPath: "/api/instance/settings/experimental",
    writePath: "/api/instance/settings/experimental",
    method: "PATCH",
    allow: Object.keys(want),
    body,
    unwrapKey: "experimental",
    expect: drift.map(([k, v]) => ({ path: k, value: v })),
    before: Object.fromEntries(drift.map(([k]) => [k, snap.experimental?.[k] ?? null])),
    after: body,
  });
}

function planProjects(cfg, snap, actions) {
  for (const p of cfg.projects) {
    const { live } = snap.projects[p.name];
    const goalIds = (p.goals ?? []).map((k) => snap.goals[k].id);

    if (!live) {
      actions.push({
        id: `project:${p.name}:create`,
        kind: "create",
        what: `create project "${p.name}"`,
        readPath: `/api/companies/${snap.company.id}/projects`,
        writePath: `/api/companies/${snap.company.id}/projects`,
        method: "POST",
        allow: ["name", "description", "status", "icon", "goalIds", "executionWorkspacePolicy"],
        body: {
          name: p.name, description: p.description, status: "in_progress", icon: "folder",
          goalIds, executionWorkspacePolicy: p.executionWorkspacePolicy,
        },
        expect: [],           // create is verified by re-resolution in apply()
        createdKind: "project",
        before: null,
        after: { name: p.name, goalIds, executionWorkspacePolicy: p.executionWorkspacePolicy },
      });
      continue;
    }

    const policyCmp = compareSubset(p.executionWorkspacePolicy, live.executionWorkspacePolicy, PROJECT_POLICY_KEYS);
    const strategyCmp = compareWorkspaceStrategy(
      p.executionWorkspacePolicy.workspaceStrategy,
      live.executionWorkspacePolicy?.workspaceStrategy,
    );
    const goalsEqual = deepEqual([...(live.goalIds ?? [])].sort(), [...goalIds].sort());

    if (policyCmp.equal && strategyCmp.equal && goalsEqual) continue;

    actions.push({
      id: `project:${p.name}:policy`,
      kind: "update",
      what: `reconcile project "${p.name}" execution workspace policy and goals`,
      readPath: `/api/projects/${live.id}`,
      writePath: `/api/projects/${live.id}`,
      method: "PATCH",
      allow: ["goalIds", "executionWorkspacePolicy"],
      body: { goalIds, executionWorkspacePolicy: p.executionWorkspacePolicy },
      unwrapKey: "project",
      expect: [
        { path: "executionWorkspacePolicy.enabled", value: p.executionWorkspacePolicy.enabled },
        { path: "executionWorkspacePolicy.defaultMode", value: p.executionWorkspacePolicy.defaultMode },
        { path: "executionWorkspacePolicy.workspaceStrategy", value: p.executionWorkspacePolicy.workspaceStrategy },
        { path: "goalIds", compare: (actual) => deepEqual([...(actual ?? [])].sort(), [...goalIds].sort()) },
      ],
      before: { goalIds: live.goalIds ?? null, executionWorkspacePolicy: live.executionWorkspacePolicy ?? null },
      after: { goalIds, executionWorkspacePolicy: p.executionWorkspacePolicy },
    });
  }
}

function planWorkspaces(cfg, snap, actions) {
  for (const p of cfg.projects) {
    const { live, workspaces } = snap.projects[p.name];
    if (!live) continue;   // project create is planned first; workspace lands on the next apply
    for (const ws of p.workspaces ?? []) {
      const existing = workspaces.find((w) => w.cwd === ws.cwd);
      if (existing) continue;
      actions.push({
        id: `workspace:${p.name}:${ws.name}`,
        kind: "create",
        what: `create project workspace "${ws.name}" -> ${ws.cwd}`,
        readPath: `/api/projects/${live.id}/workspaces`,
        writePath: `/api/projects/${live.id}/workspaces`,
        method: "POST",
        allow: ["name", "sourceType", "cwd", "defaultRef", "isPrimary"],
        body: clone(ws),
        expect: [],
        createdKind: "workspace",
        before: null,
        after: clone(ws),
      });
    }
  }
}

function planAgents(cfg, snap, actions) {
  for (const a of cfg.agents) {
    const live = snap.agents[a.name];
    const liveCfg = live.adapterConfig ?? {};
    // A managed key the config no longer declares is DRIFT TOWARDS REMOVAL, not
    // an absence to ignore. Leaving it live is how `pluginDirs` and `configFiles`
    // went on describing a boundary that the adapter had never read.
    const declared = (k) => a.adapterConfig[k] !== undefined;
    const drift = AGENT_MANAGED_KEYS.filter((k) =>
      declared(k)
        ? !deepEqual(liveCfg[k], a.adapterConfig[k])
        : liveCfg[k] !== undefined,
    );
    if (!drift.length) continue;

    // Merge into the CURRENT adapterConfig. instructionsFilePath and the other
    // server-managed instruction keys are not ours and must survive untouched;
    // replacing the object wholesale would silently unbind the agent's AGENTS.md.
    const nextCfg = { ...liveCfg };
    for (const k of AGENT_MANAGED_KEYS) {
      if (declared(k)) nextCfg[k] = a.adapterConfig[k];
      else delete nextCfg[k];
    }

    const removed = drift.filter((k) => !declared(k));

    actions.push({
      id: `agent:${a.name}:adapterConfig`,
      kind: "update",
      what: `reconcile agent "${a.name}" adapterConfig (${drift.join(", ")})`
        + (removed.length ? ` [removing ${removed.join(", ")}]` : ""),
      readPath: `/api/agents/${live.id}`,
      writePath: `/api/agents/${live.id}`,
      method: "PATCH",
      allow: ["adapterConfig"],
      body: { adapterConfig: nextCfg },
      // Assert both directions on readback: declared keys must persist with the
      // declared value, retired keys must be GONE. A PATCH that silently keeps a
      // removed key is the same 200-and-do-nothing class as one that drops a set.
      expect: AGENT_MANAGED_KEYS.map((k) =>
        declared(k)
          ? { path: `adapterConfig.${k}`, value: a.adapterConfig[k] }
          : { path: `adapterConfig.${k}`, compare: (actual) => actual === undefined },
      ),
      before: Object.fromEntries(drift.map((k) => [k, liveCfg[k] ?? null])),
      after: Object.fromEntries(drift.map((k) => [k, declared(k) ? a.adapterConfig[k] : null])),
    });
  }
}

function planAgentInstructions(cfg, snap, actions) {
  for (const agent of cfg.agents) {
    const desired = agent.instructions;
    if (!desired) continue;
    const liveAgent = snap.agents[agent.name];
    const live = snap.agentInstructions?.[agent.name] ?? null;
    if (live?.path === desired.path && live?.content === desired.content) continue;
    const query = new URLSearchParams({ path: desired.path });
    actions.push({
      id: `agent:${agent.name}:instructions`, kind: "upsert",
      what: `reconcile agent "${agent.name}" instructions ${desired.path}`,
      readPath: `/api/agents/${liveAgent.id}/instructions-bundle/file?${query.toString()}`,
      writePath: `/api/agents/${liveAgent.id}/instructions-bundle/file`, method: "PUT",
      allow: ["path", "content", "clearLegacyPromptTemplate"],
      body: { path: desired.path, content: desired.content, clearLegacyPromptTemplate: false },
      expect: [{ path: "path", value: desired.path }, { path: "content", value: desired.content }],
      allowMissingBefore: live === null,
      before: live === null ? null : { path: live.path, content: live.content },
      after: { path: desired.path, sha256: desired.sha256 },
    });
  }
}

function planIssues(cfg, snap, actions) {
  for (const i of cfg.issues) {
    const live = snap.issues[i.identifier];
    const projectId = snap.projects[i.project].live?.id ?? null;
    const goalId = snap.goals[i.goal].id;
    const assigneeAgentId = snap.agents[i.assignee].id;
    const policy = resolveExecutionPolicy(i.executionPolicy, snap);

    const body = {};
    const expect = [];
    const before = {};
    const after = {};
    const note = [];

    const scalar = (key, want, livePath = key) => {
      const has = get(live, livePath);
      if (deepEqual(has, want)) return;
      body[key] = want; expect.push({ path: livePath, value: want });
      before[key] = has ?? null; after[key] = want; note.push(key);
    };

    // THE ESCALATION TARGET. With responsibleUserId null the server skips its
    // escalation branch (issue-execution-policy.js:681) and silently reassigns
    // an exhausted review back to the Engineer — the loop the plan forbids.
    // Managed like any other field so it cannot drift away unnoticed.
    if (i.responsibleUser) {
      const userId = snap.operator?.userId;
      if (!userId) {
        throw new FactoryError(
          `issue ${i.identifier} declares responsibleUser ${JSON.stringify(i.responsibleUser)} but the ` +
          `operator did not resolve to a user id; refusing to plan an issue whose review exhaustion would loop`,
          { identifier: i.identifier, responsibleUser: i.responsibleUser },
        );
      }
      scalar("responsibleUserId", userId);
    }

    if (projectId) scalar("projectId", projectId);
    scalar("goalId", goalId);
    scalar("reviewPolicy", i.reviewPolicy);
    scalar("assigneeAgentId", assigneeAgentId);
    scalar("executionWorkspacePreference", i.executionWorkspacePreference);

    // ATOMIC. Never a partial strategy — see semdiff.compareWorkspaceStrategy.
    const wsCmp = compareWorkspaceStrategy(
      i.executionWorkspaceSettings.workspaceStrategy,
      live.executionWorkspaceSettings?.workspaceStrategy,
    );
    const modeEqual = live.executionWorkspaceSettings?.mode === i.executionWorkspaceSettings.mode;
    if (!wsCmp.equal || !modeEqual) {
      body.executionWorkspaceSettings = i.executionWorkspaceSettings;
      expect.push({ path: "executionWorkspaceSettings.mode", value: i.executionWorkspaceSettings.mode });
      expect.push({ path: "executionWorkspaceSettings.workspaceStrategy", value: i.executionWorkspaceSettings.workspaceStrategy });
      before.executionWorkspaceSettings = live.executionWorkspaceSettings ?? null;
      after.executionWorkspaceSettings = i.executionWorkspaceSettings;
      note.push("executionWorkspaceSettings");
    }

    const polCmp = compareExecutionPolicy(policy, live.executionPolicy);
    if (!polCmp.equal) {
      body.executionPolicy = policy;
      expect.push({
        path: "executionPolicy",
        compare: (actual) => compareExecutionPolicy(policy, actual).equal,
      });
      before.executionPolicy = live.executionPolicy ?? null;
      after.executionPolicy = policy;
      note.push("executionPolicy");
    }

    if (i.assigneeAdapterOverrides && !deepEqual(live.assigneeAdapterOverrides, i.assigneeAdapterOverrides)) {
      body.assigneeAdapterOverrides = i.assigneeAdapterOverrides;
      expect.push({ path: "assigneeAdapterOverrides", value: i.assigneeAdapterOverrides });
      before.assigneeAdapterOverrides = live.assigneeAdapterOverrides ?? null;
      after.assigneeAdapterOverrides = i.assigneeAdapterOverrides;
      note.push("assigneeAdapterOverrides");
    }

    if (!Object.keys(body).length) continue;

    actions.push({
      id: `issue:${i.identifier}`,
      kind: "update",
      what: `reconcile issue ${i.identifier} (${note.join(", ")})`,
      readPath: `/api/issues/${live.id}`,
      writePath: `/api/issues/${live.id}`,
      method: "PATCH",
      allow: ["projectId", "goalId", "reviewPolicy", "assigneeAgentId", "responsibleUserId",
              "executionWorkspacePreference", "executionWorkspaceSettings",
              "executionPolicy", "assigneeAdapterOverrides"],
      body, expect, before, after,
    });
  }
}

function planContractDocuments(cfg, snap, actions) {
  for (const issue of cfg.issues) {
    const desired = issue.objectiveDocument;
    if (!desired) continue;
    const liveIssue = snap.issues[issue.identifier];
    const live = snap.issueDocuments?.[issue.identifier]?.[desired.key] ?? null;
    // FIELD NAME: the API renames its column on the way out —
    // services/documents.js:48 maps `body: row.latestBody`, so `latestBody` is
    // the DATABASE column and `body` is the only thing a GET ever returns.
    // Comparing against `latestBody` here compares against undefined: every
    // document reads as permanently drifted, and every apply fails its own
    // readback as "did not persist". Covered by documents-api-shape.test.js.
    if (live?.title === desired.title && live?.format === desired.format && live?.body === desired.body) continue;
    const body = {
      title: desired.title,
      format: desired.format,
      body: desired.body,
      changeSummary: desired.changeSummary,
    };
    if (live?.latestRevisionId) body.baseRevisionId = live.latestRevisionId;
    actions.push({
      id: `issue:${issue.identifier}:document:${desired.key}`, kind: "upsert",
      what: `reconcile immutable objective document ${issue.identifier}/${desired.key}`,
      readPath: `/api/issues/${liveIssue.id}/documents/${encodeURIComponent(desired.key)}`,
      writePath: `/api/issues/${liveIssue.id}/documents/${encodeURIComponent(desired.key)}`, method: "PUT",
      allow: ["title", "format", "body", "changeSummary", "baseRevisionId"], body,
      expect: [
        { path: "title", value: desired.title },
        { path: "format", value: desired.format },
        { path: "body", value: desired.body },
        { path: "latestRevisionId", compare: (actual) => typeof actual === "string" && actual.length > 0 },
      ],
      allowMissingBefore: live === null,
      before: live === null ? null : {
        title: live.title, format: live.format, body: live.body,
        latestRevisionId: live.latestRevisionId,
      },
      restore: live === null ? null : {
        title: live.title, format: live.format, body: live.body,
        latestRevisionId: live.latestRevisionId,
      },
      // RESTORE CANNOT BE DERIVED from allow∩before. This endpoint REQUIRES
      // baseRevisionId on every update — documents.js:291 rejects an update
      // without one outright ("Document update requires baseRevisionId") — and
      // the generic derivation has no way to carry a value that is only known
      // after the forward write. Declare the exact restoring write instead.
      restoreMutation: live === null ? null : {
        body: {
          title: live.title, format: live.format, body: live.body,
          changeSummary: `rollback: restore ${issue.identifier}/${desired.key} to pre-apply content`,
        },
        // The restoring PUT must carry the SAME optimistic-concurrency guard the
        // forward write does, or a document written by anyone else between apply
        // and rollback is silently clobbered. The revision to bind to is the one
        // THIS apply produced, which is unknowable at plan time — so name the
        // readback field whose applied value apply must send as `baseRevisionId`.
        baseRevisionFrom: "latestRevisionId",
        expect: [
          { path: "title", value: live.title },
          { path: "format", value: live.format },
          { path: "body", value: live.body },
        ],
      },
      after: {
        title: desired.title, format: desired.format, bodyHash: desired.bodyHash,
        objectiveHash: desired.objective.objectiveHash, criteriaHash: desired.objective.criteriaHash,
        revision: desired.objective.revision,
      },
    });
  }
}

/** Build the full plan. Order matters: flags, then containers, then members. */
async function buildPlan(api, cfg, snap) {
  const s = snap ?? (await snapshot(api, cfg));
  const actions = [];
  planInstance(cfg, s, actions);
  planProjects(cfg, s, actions);
  planWorkspaces(cfg, s, actions);
  planAgents(cfg, s, actions);
  planAgentInstructions(cfg, s, actions);
  planIssues(cfg, s, actions);
  planContractDocuments(cfg, s, actions);

  // The hash covers desired AND observed state. Applying a plan built against
  // different live state than is present now must fail, not silently clobber.
  const hashable = actions.map((a) => ({
    id: a.id, kind: a.kind, method: a.method, writePath: a.writePath,
    allow: a.allow, body: a.body, before: a.before, after: a.after,
  }));
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    configFile: cfg._file,
    company: s.company.name,
    actions,
    planHash: hashValue({ version: 1, actions: hashable }),
    snapshot: s,
  };
}

module.exports = {
  snapshot, buildPlan, resolveExecutionPolicy, planAgentInstructions, planContractDocuments,
  planIssues, planAgents,
  AGENT_MANAGED_KEYS, PROJECT_POLICY_KEYS,
};
