"use strict";
// Name -> id resolution against the live instance.
//
// Nothing downstream may hardcode a database UUID. Every id used by a plan is
// resolved here, at plan time, from a stable human identifier, and a name that
// resolves to zero or to more than one row is an error rather than a guess.

const { FactoryError } = require("./util");

const asArray = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  for (const k of keys) if (Array.isArray(v?.[k])) return v[k];
  return [];
};

function one(rows, predicate, what) {
  const hits = rows.filter(predicate);
  if (hits.length === 0) throw new FactoryError(`no ${what} found`);
  if (hits.length > 1) throw new FactoryError(`${what} is ambiguous: ${hits.length} matches`);
  return hits[0];
}

class Resolver {
  constructor(api) { this.api = api; this.cache = {}; }

  async company(name) {
    if (this.cache.company) return this.cache.company;
    const rows = asArray(await this.api.get("/api/companies"), "companies");
    const hit = one(rows, (c) => c.name === name, `company named "${name}"`);
    this.cache.company = hit;
    return hit;
  }

  async goals(companyId) {
    if (this.cache.goals) return this.cache.goals;
    this.cache.goals = asArray(await this.api.get(`/api/companies/${companyId}/goals`), "goals");
    return this.cache.goals;
  }

  /** Goals are matched by title PREFIX: the full title is a paragraph. */
  async goal(companyId, titlePrefix) {
    const rows = await this.goals(companyId);
    return one(rows, (g) => String(g.title ?? "").startsWith(titlePrefix),
      `goal whose title starts with "${titlePrefix.slice(0, 40)}..."`);
  }

  async agents(companyId) {
    if (this.cache.agents) return this.cache.agents;
    this.cache.agents = asArray(await this.api.get(`/api/companies/${companyId}/agents`), "agents");
    return this.cache.agents;
  }

  async agent(companyId, name) {
    return one(await this.agents(companyId), (a) => a.name === name, `agent named "${name}"`);
  }

  async projects(companyId) {
    if (this.cache.projects) return this.cache.projects;
    this.cache.projects = asArray(await this.api.get(`/api/companies/${companyId}/projects`), "projects");
    return this.cache.projects;
  }

  /** Returns null rather than throwing: a missing project is a create action. */
  async projectOrNull(companyId, name) {
    const hits = (await this.projects(companyId)).filter((p) => p.name === name);
    if (hits.length > 1) throw new FactoryError(`project named "${name}" is ambiguous`);
    return hits[0] ?? null;
  }

  async issues(companyId) {
    if (this.cache.issues) return this.cache.issues;
    this.cache.issues = asArray(await this.api.get(`/api/companies/${companyId}/issues`), "issues");
    return this.cache.issues;
  }

  async issue(companyId, identifier) {
    const stub = one(await this.issues(companyId), (i) => i.identifier === identifier,
      `issue with identifier "${identifier}"`);
    // The list projection omits executionPolicy detail; always re-fetch the row.
    return await this.api.get(`/api/issues/${stub.id}`);
  }

  async member(companyId, email) {
    const rows = asArray(await this.api.get(`/api/companies/${companyId}/members`), "members");
    const hit = one(rows, (m) => (m.email ?? m.user?.email) === email, `company member with email "${email}"`);
    return { userId: hit.userId ?? hit.id, email };
  }

  async projectWorkspaces(projectId) {
    return asArray(await this.api.get(`/api/projects/${projectId}/workspaces`), "workspaces");
  }

  async issueDocument(issueId, key) {
    return this.api.getOptional(`/api/issues/${issueId}/documents/${encodeURIComponent(key)}`);
  }

  async agentInstructions(agentId, instructionPath) {
    const query = new URLSearchParams({ path: instructionPath });
    return this.api.getOptional(`/api/agents/${agentId}/instructions-bundle/file?${query.toString()}`);
  }

  /** Flush caches so a post-apply readback cannot be served from pre-apply data. */
  invalidate() { this.cache = {}; }
}

module.exports = { Resolver, asArray };
