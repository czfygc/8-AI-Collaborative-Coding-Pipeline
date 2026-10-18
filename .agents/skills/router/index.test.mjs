import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply, routeQuery } from "./index.js";

const FIXTURE_ROOT = join(process.cwd(), ".agents", "skills", "router", ".test-fixtures");
const fixtureRoots = [];

after(async () => {
  await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true, force: true })));
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

const DEFAULT_REGISTRY = {
  schemaVersion: 1,
  maxMatches: 2,
  maxFullPayloads: 3,
  skills: [
    {
      name: "forced-alpha",
      category: "analytics",
      description: "Forced alpha instructions.",
      triggers: ["forced alpha trigger"],
      keywords: ["forced", "alpha"],
      alwaysAttach: true,
      payload: "SKILL.md",
    },
    {
      name: "beta-explicit",
      category: "analytics",
      description: "Beta explicit instructions.",
      triggers: ["beta explicit trigger"],
      keywords: ["explicit", "beta"],
      payload: "SKILL.md",
    },
    {
      name: "gamma-category",
      category: "analytics",
      description: "Gamma category member.",
      triggers: ["gamma category trigger"],
      keywords: ["category", "gamma"],
      payload: "SKILL.md",
    },
    {
      name: "delta-semantic",
      category: "reporting",
      description: "Delta semantic paraphrase handling.",
      triggers: ["delta semantic trigger"],
      keywords: ["robust parameter sensitivity", "structured visualization fallback"],
      payload: "SKILL.md",
    },
    {
      name: "tie-alpha",
      category: "ties",
      description: "Tie alpha member.",
      keywords: ["tie", "alpha"],
      payload: "SKILL.md",
    },
    {
      name: "tie-beta",
      category: "ties",
      description: "Tie beta member.",
      keywords: ["tie", "beta"],
      payload: "SKILL.md",
    },
  ],
};

const DEFAULT_CATEGORIES = {
  schemaVersion: 1,
  categories: {
    analytics: {
      label: "Analytics",
      terms: ["walk-forward", "rolling validation", "out-of-sample"],
      skills: ["forced-alpha", "beta-explicit", "gamma-category"],
    },
    reporting: {
      label: "Reporting",
      terms: ["chart", "structured visualization"],
      skills: ["delta-semantic"],
    },
    ties: {
      label: "Ties",
      terms: ["tied category"],
      skills: ["tie-alpha", "tie-beta"],
    },
  },
};

function payloadFor(name) {
  return {
    name,
    provider: "test-provider",
    content: `# ${name}\n\nFixture payload for ${name}.`,
    resourceBase: { kind: "directory", path: join(FIXTURE_ROOT, name), description: "fixture" },
  };
}

function userMessage(text, id = "current-user-message") {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function createRuntime(extraPayloadNames = []) {
  const tools = [];
  const handlers = new Map();
  const gets = [];
  const payloads = new Map(DEFAULT_REGISTRY.skills.map((skill) => [skill.name, payloadFor(skill.name)]));
  for (const name of extraPayloadNames) {
    if (!payloads.has(name)) payloads.set(name, payloadFor(name));
  }
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool);
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    skills: {
      async list() {
        return [...payloads.keys()].map((name) => ({ name, invocation: { modelInvocable: true } }));
      },
      async get(name, options) {
        gets.push({ name, options });
        const payload = payloads.get(name);
        if (!payload) throw new Error(`fixture payload not found: ${name}`);
        return payload;
      },
    },
  };
  return { ctx, tools, handlers, gets, payloads };
}

function toolByName(runtime, name) {
  return runtime.tools.find((tool) => tool.name === name);
}

async function callPreStep(runtime, agent, text, next) {
  const handler = runtime.handlers.get("agent/pre-step");
  if (!handler) throw new Error("agent/pre-step handler was not registered");
  const calls = [];
  const baseNext = next ?? (async () => {
    calls.push("next");
    return { kind: "enter", messages: [userMessage("downstream context")] };
  });
  const decision = await handler(
    { agent, messages: [userMessage(text)], turn: 1, step: 1, signal: new AbortController().signal },
    async () => baseNext(),
  );
  return { decision, calls };
}

function injectedSkills(decision) {
  return (decision.messages ?? [])
    .filter((message) => message.source?.kind === "skill-router" && message.source?.form === "instructions")
    .map((message) => ({ name: message.source.name, layer: message.source.route?.layer }));
}

function fallbackText(decision) {
  return (decision.messages ?? [])
    .filter((message) => message.source?.kind === "skill-router-fallback")
    .map((message) => message.content?.[0]?.text ?? "")
    .join("\n");
}

async function makeFixture(registryOverrides = {}, categoryOverrides = {}) {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const root = await mkdtemp(join(FIXTURE_ROOT, "case-"));
  const registry = { ...DEFAULT_REGISTRY, ...registryOverrides };
  const categories = { ...DEFAULT_CATEGORIES, ...categoryOverrides };
  for (const skill of registry.skills) {
    await mkdir(join(root, skill.name), { recursive: true });
    await writeFile(join(root, skill.name, "SKILL.md"), `# ${skill.name}\n`, "utf8");
  }
  await writeFile(join(root, "registry.json"), JSON.stringify(registry, null, 2), "utf8");
  await writeFile(join(root, "categories.json"), JSON.stringify(categories, null, 2), "utf8");
  fixtureRoots.push(root);
  return { root, registry, categories };
}

async function mountFixture(registryOverrides = {}, categoryOverrides = {}) {
  const fixture = await makeFixture(registryOverrides, categoryOverrides);
  const runtime = createRuntime();
  apply(runtime.ctx, { skillRoot: fixture.root, alwaysAttachSkill: "forced-alpha" });
  const agent = { id: "fixture-agent", session: { header: { cwd: fixture.root } } };
  return { ...fixture, runtime, agent };
}

test("metadata-only category listing never loads full payloads", async () => {
  const { runtime, agent } = await mountFixture();
  const listTool = toolByName(runtime, "list_skill_categories");
  const output = await listTool.execute({ query: "analytics" }, { agent, signal: new AbortController().signal });

  assert.equal(runtime.gets.length, 0, "ctx.skills.get must not be called by metadata listing");
  assert.equal(output.status, "ok");
  assert.deepEqual(output.availableSkills, DEFAULT_REGISTRY.skills.map((skill) => skill.name).sort());
  assert.equal(JSON.stringify(output).includes("Fixture payload"), false, "payload content must not leak into metadata");
});

test("exact explicit trigger has priority over category and semantic evidence", async () => {
  const { runtime, agent } = await mountFixture();
  const { decision } = await callPreStep(runtime, agent, "Please use beta explicit trigger plus walk-forward and robust parameter sensitivity.");
  const injected = injectedSkills(decision);

  assert.deepEqual(injected.map((item) => item.name), ["forced-alpha", "beta-explicit"]);
  assert.equal(injected[1].layer, "explicit");
  assert.equal(runtime.gets.filter((entry) => entry.name === "beta-explicit").length, 1);
  assert.equal(runtime.gets.some((entry) => entry.name === "delta-semantic"), false);
});

test("slash gesture is treated as an explicit trigger", async () => {
  const { runtime, agent } = await mountFixture();
  const { decision } = await callPreStep(runtime, agent, "/beta-explicit");
  const injected = injectedSkills(decision);

  assert.deepEqual(injected.map((item) => item.name), ["forced-alpha", "beta-explicit"]);
  assert.equal(injected[1].layer, "explicit");
});

test("explicit trigger on an always-attached Skill is audited as explicit", () => {
  const registry = {
    maxMatches: DEFAULT_REGISTRY.maxMatches,
    maxFullPayloads: DEFAULT_REGISTRY.maxFullPayloads,
    skills: DEFAULT_REGISTRY.skills,
    categories: DEFAULT_CATEGORIES.categories,
  };
  const route = routeQuery("forced alpha trigger", registry, "forced-alpha");

  assert.equal(route.status, "explicit");
  assert.deepEqual(route.selectedNames, ["forced-alpha"]);
  assert.deepEqual(route.layers.find((layer) => layer.layer === "explicit").selected, ["forced-alpha"]);
});

test("category fallback selects deterministic category members before semantic matches", async () => {
  const { runtime, agent } = await mountFixture();
  const { decision } = await callPreStep(runtime, agent, "walk-forward rolling validation");
  const injected = injectedSkills(decision);

  assert.deepEqual(injected.map((item) => item.name), ["forced-alpha", "beta-explicit", "gamma-category"]);
  assert.equal(injected.every((item) => item.layer === "category" || item.name === "forced-alpha"), true);
  assert.equal(runtime.gets.some((entry) => entry.name === "delta-semantic"), false);
});

test("semantic fallback reaches metadata evidence when no explicit or category match exists", async () => {
  const { runtime, agent } = await mountFixture();
  const { decision } = await callPreStep(runtime, agent, "robust parameter sensitivity");
  const injected = injectedSkills(decision);

  assert.deepEqual(injected.map((item) => item.name), ["forced-alpha", "delta-semantic"]);
  assert.equal(injected[1].layer, "semantic");
});

test("alwaysAttach remains mandatory and consumes a payload slot", async () => {
  const { runtime, agent } = await mountFixture({ maxMatches: 1, maxFullPayloads: 1 });
  const { decision } = await callPreStep(runtime, agent, "beta explicit trigger");
  const injected = injectedSkills(decision);

  assert.deepEqual(injected.map((item) => item.name), ["forced-alpha"]);
  assert.equal(runtime.gets.length, 1);
  assert.equal(runtime.gets[0].name, "forced-alpha");
});

test("maxMatches limits optional routes while maxFullPayloads limits payloads", async () => {
  const { runtime, agent } = await mountFixture({ maxMatches: 1, maxFullPayloads: 3 });
  const { decision } = await callPreStep(runtime, agent, "walk-forward rolling validation");
  const injected = injectedSkills(decision);

  assert.deepEqual(injected.map((item) => item.name), ["forced-alpha", "beta-explicit"]);
  assert.equal(runtime.gets.some((entry) => entry.name === "gamma-category"), false);
});

test("unknown requests do not activate unrelated Skills and emit an auditable fallback", async () => {
  const { runtime, agent } = await mountFixture();
  const { decision } = await callPreStep(runtime, agent, "zzz unrelated request");
  const injected = injectedSkills(decision);
  const fallback = fallbackText(decision);

  assert.deepEqual(injected.map((item) => item.name), ["forced-alpha"]);
  assert.equal(fallback.includes("ROUTING_FALLBACK = ACTIVE"), true);
  assert.equal(fallback.includes("ROUTE_LAYER = forced-only"), true);
  assert.equal(fallback.includes("ROUTE_INPUT_BOUNDARY = agent/pre-step claimed current-step messages"), true);
  assert.equal(fallback.includes("beta-explicit"), false);
});

test("load_skill loads only the requested payload on demand", async () => {
  const { runtime, agent } = await mountFixture();
  const loadTool = toolByName(runtime, "load_skill");
  const output = await loadTool.execute({ name: "delta-semantic" }, { agent, signal: new AbortController().signal });

  assert.equal(output.status, "ok");
  assert.equal(output.name, "delta-semantic");
  assert.equal(output.routing.level, "explicit");
  assert.equal(output.content.includes("Delta semantic paraphrase handling."), false);
  assert.equal(runtime.gets.filter((entry) => entry.name === "delta-semantic").length, 1);
  assert.equal(runtime.gets.some((entry) => entry.name === "beta-explicit"), false);
});

test("route audits are deterministic across repeated runs and ties", () => {
  const registry = {
    maxMatches: DEFAULT_REGISTRY.maxMatches,
    maxFullPayloads: DEFAULT_REGISTRY.maxFullPayloads,
    skills: DEFAULT_REGISTRY.skills,
    categories: DEFAULT_CATEGORIES.categories,
  };
  const first = routeQuery("tied category", registry, "forced-alpha");
  const second = routeQuery("tied category", registry, "forced-alpha");

  assert.deepEqual(first, second);
  assert.equal(first.status, "category");
  assert.deepEqual(first.layers.find((layer) => layer.layer === "category").selected, ["tie-alpha", "tie-beta"]);
});

test("dispatch injects instructions only and routes from the current claimed step", async () => {
  const { runtime, agent } = await mountFixture();
  const first = await callPreStep(runtime, agent, "Please use beta explicit trigger.");
  const second = await callPreStep(runtime, agent, "zzz unrelated request");

  assert.equal(first.calls[0], "next", "the router joins the existing pre-step waterfall");
  assert.deepEqual(injectedSkills(first.decision).map((item) => item.name), ["forced-alpha", "beta-explicit"]);
  assert.equal(injectedSkills(second.decision).some((item) => item.name === "beta-explicit"), false, "historical request text must not route");
  assert.equal(fallbackText(second.decision).includes("beta-explicit"), false, "historical request text must not route");
  assert.equal(runtime.gets.some((entry) => entry.name === "gamma-category"), false, "unrelated category member must not load");
});

test("unavailable registered Skill reports failure without masking UNKNOWN", async () => {
  const { runtime, agent } = await mountFixture();
  const loadTool = toolByName(runtime, "load_skill");
  runtime.payloads.delete("delta-semantic");
  const output = await loadTool.execute({ name: "delta-semantic" }, { agent, signal: new AbortController().signal });

  assert.equal(output.status, "failed");
  assert.equal(output.routing.matched, false);
  assert.equal(output.warnings.some((warning) => warning.includes("preserve UNKNOWN")), true);
});

function callPreStepWithMessages(runtime, agent, messages, next) {
  const handler = runtime.handlers.get("agent/pre-step");
  if (!handler) throw new Error("agent/pre-step handler was not registered");
  const calls = [];
  const baseNext = next ?? (async () => {
    calls.push("next");
    return { kind: "enter", messages: [userMessage("downstream context")] };
  });
  return handler(
    { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
    async () => baseNext(),
  ).then((decision) => ({ decision, calls }));
}

function auditText(decision) {
  return (decision.messages ?? [])
    .filter((message) => message.source?.kind === "skill-router-audit")
    .map((message) => message.content?.[0]?.text ?? "")
    .join("\n");
}

function payloadStats(runtime, decision) {
  const injected = injectedSkills(decision);
  const text = injected.map((item) => {
    const payload = runtime.payloads.get(item.name);
    return payload?.content ?? "";
  }).join("\n");
  return {
    getCount: runtime.gets.length,
    injectedCount: injected.length,
    payloadCharacters: Buffer.byteLength(text, "utf8"),
    payloadBytes: Buffer.byteLength(text, "utf8"),
  };
}

async function mountScaleFixture(skillCount = 127) {
  const skills = [];
  for (let index = 0; index < skillCount; index += 1) {
    const name = index === 0 ? "forced-alpha" : `scale-${String(index).padStart(3, "0")}`;
    skills.push({
      name,
      category: "scale-category",
      description: `Scale fixture Skill ${index} for deterministic metadata routing.`,
      triggers: index === 63 ? ["scale explicit trigger"] : [],
      keywords: index === 63 ? ["semantic-only-phrase", "scale semantic"] : [`scale keyword ${index}`],
      ...(index === 0 ? { alwaysAttach: true } : {}),
      payload: "SKILL.md",
    });
  }
  const registry = {
    schemaVersion: 1,
    maxMatches: 3,
    maxFullPayloads: 3,
    skills,
  };
  const categories = {
    schemaVersion: 1,
    categories: {
      "scale-category": {
        label: "Scale Category",
        terms: ["category-only-phrase", "scale category"],
        skills: skills.map((skill) => skill.name),
      },
    },
  };
  const root = await makeFixtureRoot(registry, categories);
  const runtime = createRuntime(skills.map((skill) => skill.name));
  apply(runtime.ctx, { skillRoot: root, alwaysAttachSkill: "forced-alpha" });
  const agent = { id: "scale-agent", session: { header: { cwd: root } } };
  return { root, registry, categories, runtime, agent };
}

async function makeFixtureRoot(registry, categories) {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const root = await mkdtemp(join(FIXTURE_ROOT, "case-"));
  for (const skill of registry.skills) {
    await mkdir(join(root, skill.name), { recursive: true });
    await writeFile(join(root, skill.name, "SKILL.md"), `# ${skill.name}\n`, "utf8");
  }
  await writeFile(join(root, "registry.json"), JSON.stringify(registry, null, 2), "utf8");
  await writeFile(join(root, "categories.json"), JSON.stringify(categories, null, 2), "utf8");
  fixtureRoots.push(root);
  return root;
}

test("approximately 127 metadata entries keep listing and routing payload loads bounded", async () => {
  const listing = await mountScaleFixture(127);
  const listTool = toolByName(listing.runtime, "list_skill_categories");
  const listed = await listTool.execute({ query: "scale" }, { agent: listing.agent, signal: new AbortController().signal });

  assert.equal(listing.runtime.gets.length, 0, "metadata listing must not call ctx.skills.get");
  assert.equal(listed.availableSkills.length, 132);  // 127 scale + 6 default fixture skills, with forced-alpha de-duplicated
  assert.equal(listed.categories[0].skillCount, 127);

  const explicitFixture = await mountScaleFixture(127);
  const explicit = await callPreStep(explicitFixture.runtime, explicitFixture.agent, "scale-063");
  const explicitStats = payloadStats(explicitFixture.runtime, explicit.decision);
  assert.deepEqual(injectedSkills(explicit.decision).map((item) => item.name), ["forced-alpha", "scale-063"]);
  assert.equal(explicitStats.getCount, 2, "explicit routing must load only forced plus exact Skill");
  assert.equal(explicitStats.injectedCount, 2);
  assert.equal(explicitStats.payloadCharacters > 0, true);

  const categoryFixture = await mountScaleFixture(127);
  const category = await callPreStep(categoryFixture.runtime, categoryFixture.agent, "category-only-phrase");
  const categoryStats = payloadStats(categoryFixture.runtime, category.decision);
  assert.equal(categoryStats.getCount, 3, "category routing must load forced plus at most maxMatches optional Skills");
  assert.equal(categoryStats.injectedCount, 3);

  const semanticFixture = await mountScaleFixture(127);
  const semantic = await callPreStep(semanticFixture.runtime, semanticFixture.agent, "semantic-only-phrase");
  const semanticStats = payloadStats(semanticFixture.runtime, semantic.decision);
  assert.equal(semanticStats.getCount, 2, "semantic routing must load one bounded optional Skill");
  assert.equal(semanticStats.injectedCount, 2);
});

test("repeated identical routing does not reload or reinject payloads", async () => {
  const { runtime, agent } = await mountScaleFixture(127);
  const first = await callPreStep(runtime, agent, "category-only-phrase");
  const firstStats = payloadStats(runtime, first.decision);
  const second = await callPreStep(runtime, agent, "category-only-phrase");
  const secondStats = payloadStats(runtime, second.decision);

  assert.equal(firstStats.getCount, 3);
  assert.equal(secondStats.getCount, 3, "repeated routing must reuse agent-scoped injection state");
  assert.equal(firstStats.injectedCount, 3);
  assert.equal(secondStats.injectedCount, 0, "duplicate payloads must not be reinjected");
});

test("explicit trigger remains terminal when unrelated category metadata also matches", async () => {
  const { runtime, agent } = await mountScaleFixture(127);
  const { decision } = await callPreStep(runtime, agent, "scale explicit trigger category-only-phrase");
  const names = injectedSkills(decision).map((item) => item.name);

  assert.deepEqual(names, ["forced-alpha", "scale-063"]);
  assert.equal(runtime.gets.some((entry) => entry.name === "scale-001"), false);
});

test("explicit Skill name remains terminal when category metadata also matches", async () => {
  const { runtime, agent } = await mountScaleFixture(127);
  const { decision } = await callPreStep(runtime, agent, "scale-063 category-only-phrase");
  const names = injectedSkills(decision).map((item) => item.name);

  assert.deepEqual(names, ["forced-alpha", "scale-063"]);
  assert.equal(runtime.gets.some((entry) => entry.name === "scale-001"), false);
});

test("unknown request emits fallback without activating unrelated Skills", async () => {
  const { runtime, agent } = await mountScaleFixture(127);
  const { decision } = await callPreStep(runtime, agent, "zzz unrelated request");
  const fallback = fallbackText(decision);

  assert.deepEqual(injectedSkills(decision).map((item) => item.name), ["forced-alpha"]);
  assert.equal(fallback.includes("ROUTE_LAYER = forced-only"), true);
  assert.equal(fallback.includes("ROUTE_SELECTED = forced-alpha"), true);
  assert.equal(fallback.includes("scale-063"), false);
});

test("empty input preserves alwaysAttach and reports forced-only audit", async () => {
  const { runtime, agent } = await mountScaleFixture(127);
  const { decision } = await callPreStep(runtime, agent, "   ");
  const audit = auditText(decision);

  assert.deepEqual(injectedSkills(decision).map((item) => item.name), ["forced-alpha"]);
  assert.equal(audit.includes("status = forced-only"), true);
  assert.equal(audit.includes("selectedNames = forced-alpha"), true);
  assert.equal(audit.includes("inputBoundary = agent/pre-step claimed current-step messages"), true);
});

test("multiple current-step user messages are combined at the input boundary", async () => {
  const { runtime, agent } = await mountScaleFixture(127);
  const messages = [
    userMessage("Please analyze", "current-user-1"),
    { id: "current-assistant", role: "assistant", content: [{ type: "text", text: "historical beta explicit trigger" }], source: { kind: "assistant" } },
    userMessage("semantic-only-phrase", "current-user-2"),
  ];
  const { decision } = await callPreStepWithMessages(runtime, agent, messages);

  assert.deepEqual(injectedSkills(decision).map((item) => item.name), ["forced-alpha", "scale-063"]);
  assert.equal(runtime.gets.some((entry) => entry.name === "beta-explicit"), false);
});

test("historical task text in non-user messages cannot restore or activate another task", async () => {
  const { runtime, agent } = await mountFixture();
  const messages = [
    userMessage("zzz unrelated request", "current-user"),
    { id: "historical-task", role: "user", content: [{ type: "text", text: "Please use beta explicit trigger" }], source: { kind: "historical-replay" } },
  ];
  const { decision } = await callPreStepWithMessages(runtime, agent, messages);

  assert.deepEqual(injectedSkills(decision).map((item) => item.name), ["forced-alpha"]);
  assert.equal(fallbackText(decision).includes("beta-explicit"), false);
  assert.equal(fallbackText(decision).includes("TASK-2"), false);
});

test("alwaysAttach plus maxMatches cannot exceed maxFullPayloads", async () => {
  const { runtime, agent } = await mountFixture({ maxMatches: 3, maxFullPayloads: 2 });
  const { decision } = await callPreStep(runtime, agent, "walk-forward rolling validation");

  assert.deepEqual(injectedSkills(decision).map((item) => item.name), ["forced-alpha", "beta-explicit"]);
  assert.equal(runtime.gets.length, 2);
});

test("maxFullPayloads boundary includes forced payload and limits optional payloads", async () => {
  const { runtime, agent } = await mountFixture({ maxMatches: 3, maxFullPayloads: 1 });
  const { decision } = await callPreStep(runtime, agent, "category-only-phrase");

  assert.deepEqual(injectedSkills(decision).map((item) => item.name), ["forced-alpha"]);
  assert.equal(runtime.gets.length, 1);
});

test("duplicate metadata evidence cannot duplicate a selected Skill", async () => {
  const registry = {
    maxMatches: 3,
    maxFullPayloads: 3,
    skills: DEFAULT_REGISTRY.skills,
    categories: DEFAULT_CATEGORIES.categories,
  };
  const route = routeQuery("beta explicit trigger beta explicit trigger", registry, "forced-alpha");
  const explicit = route.layers.find((layer) => layer.layer === "explicit");

  assert.equal(route.status, "explicit");
  assert.deepEqual(explicit.selected, ["beta-explicit"]);
  assert.equal(route.selectedNames.filter((name) => name === "beta-explicit").length, 1);
});

test("invalid registry fails closed and does not load optional payloads", async () => {
  const { runtime, agent, root } = await mountFixture();
  await writeFile(join(root, "registry.json"), "{ invalid json", "utf8");
  const { decision } = await callPreStep(runtime, agent, "beta explicit trigger");
  const fallback = fallbackText(decision);

  assert.deepEqual(injectedSkills(decision), []);
  assert.equal(runtime.gets.length, 0);
  assert.equal(fallback.includes("ROUTER_STATUS = invalid"), true);
  assert.equal(fallback.includes("ROUTE_LAYER = invalid"), true);
});

test("load_skill exact-name failure is explicit and metadata-only on miss", async () => {
  const { runtime, agent } = await mountFixture();
  const loadTool = toolByName(runtime, "load_skill");
  const missing = await loadTool.execute({ name: "does-not-exist" }, { agent, signal: new AbortController().signal });
  const invalid = await loadTool.execute({ name: "../forced-alpha" }, { agent, signal: new AbortController().signal });

  assert.equal(missing.status, "failed");
  assert.equal(missing.routing.matched, false);
  assert.equal(missing.content.includes("not present in the router registry"), true);
  assert.equal(invalid.status, "failed");
  assert.equal(runtime.gets.length, 0);
});

test("successful routes expose structured audit fields", async () => {
  const { runtime, agent } = await mountFixture();
  const { decision } = await callPreStep(runtime, agent, "beta explicit trigger");
  const audit = auditText(decision);

  assert.equal(audit.includes("status = explicit"), true);
  assert.equal(audit.includes("layers = alwaysAttach,explicit"), true);
  assert.equal(audit.includes("selectedNames = forced-alpha,beta-explicit"), true);
  assert.equal(audit.includes("limits.maxFullPayloads = 3"), true);
  assert.equal(audit.includes("inputBoundary = agent/pre-step claimed current-step messages"), true);
});

// Additional adversarial tests for TASK-1 acceptance criteria

test("TASK-2 explicit wording does not activate TASK-2 or restore historical tasks", async () => {
  const { runtime, agent } = await mountFixture();
  const messages = [
    userMessage("Please handle TASK-2 Browser Automation", "current-user"),
    { id: "historical-task-2", role: "user", content: [{ type: "text", text: "TASK-2: please activate browser automation" }], source: { kind: "user" } },
  ];
  const { decision } = await callPreStepWithMessages(runtime, agent, messages);
  const injected = injectedSkills(decision);

  assert.deepEqual(injected.map((item) => item.name), ["forced-alpha"]);
  assert.equal(fallbackText(decision).includes("beta-explicit"), false);
  assert.equal(fallbackText(decision).includes("forced-beta"), false);
  assert.equal(runtime.gets.length, 1, "only forced-alpha payload loaded");
});

test("router never executes user tasks—only delegates via next()", async () => {
  const { runtime, agent } = await mountFixture();
  let nextCalls = 0;
  const customNext = async () => {
    nextCalls += 1;
    return { kind: "enter", messages: [userMessage("downstream context")] };
  };
  const { decision } = await callPreStep(runtime, agent, "beta explicit trigger", customNext);

  assert.deepEqual([...runtime.handlers.keys()], ["agent/pre-step"], "router must register only the pre-step handler");
  assert.equal(nextCalls, 1, "router must delegate exactly once");
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.some((message) => message.content?.[0]?.text === "downstream context"), true, "downstream decision must be preserved");
  assert.equal(injectedSkills(decision).map((item) => item.name).includes("beta-explicit"), true);
});

test("non-integer budget validation fails closed with invalid registry status", async () => {
  const { runtime, agent, root } = await mountFixture();
  // Overwrite registry with non-integer budget values
  const invalidRegistry = {
    schemaVersion: 1,
    maxMatches: 2.5,
    maxFullPayloads: 2.8,
    skills: DEFAULT_REGISTRY.skills,
    categories: DEFAULT_CATEGORIES.categories,
  };
  await writeFile(join(root, "registry.json"), JSON.stringify(invalidRegistry, null, 2), "utf8");
  
  const { decision } = await callPreStep(runtime, agent, "beta explicit trigger");
  const fallback = fallbackText(decision);
  const injected = injectedSkills(decision);

  assert.equal(injected.length, 0, "no payloads loaded for invalid registry");
  assert.equal(fallback.includes("ROUTER_STATUS = invalid"), true);
  assert.equal(runtime.gets.length, 0, "no ctx.skills.get calls for invalid registry");
});

test("different agents maintain isolated state across turns", async () => {
  const runtime = createRuntime();
  const root = await makeFixtureRoot({ ...DEFAULT_REGISTRY }, { ...DEFAULT_CATEGORIES });
  apply(runtime.ctx, { skillRoot: root, alwaysAttachSkill: "forced-alpha" });
  const agent1 = { id: "agent-1", session: { header: { cwd: root } } };
  const agent2 = { id: "agent-2", session: { header: { cwd: root } } };
  
  const call1 = await callPreStep(runtime, agent1, "beta explicit trigger");
  const call2 = await callPreStep(runtime, agent2, "beta explicit trigger");
  
  assert.equal(runtime.gets.length, 4); // Each agent loads separately
  assert.equal(injectedSkills(call1.decision).length, 2);
  assert.equal(injectedSkills(call2.decision).length, 2);
});

test("configured registry paths escaping skillRoot are validated", async () => {
  const { root } = await mountFixture();
  const runtime = createRuntime();
  apply(runtime.ctx, { skillRoot: root, registryFile: "../registry.json", alwaysAttachSkill: "forced-alpha" });
  const agent = { id: "path-escape-agent", session: { header: { cwd: root } } };
  
  const { decision } = await callPreStep(runtime, agent, "beta explicit trigger");
  const fallback = fallbackText(decision);
  
  assert.equal(fallback.includes("ROUTER_STATUS = invalid"), true);
  assert.equal(injectedSkills(decision).length, 0);
  assert.equal(runtime.gets.length, 0);
});

test("unavailable unrelated Skills warn but do not block selected Skills", async () => {
  const runtime = createRuntime();
  const root = await makeFixtureRoot({ ...DEFAULT_REGISTRY }, { ...DEFAULT_CATEGORIES });
  apply(runtime.ctx, { skillRoot: root, alwaysAttachSkill: "forced-alpha" });
  const agent = { id: "agent-unavailable", session: { header: { cwd: root } } };
  
  // Make delta-semantic unavailable (not selected in beta query)
  runtime.payloads.delete("delta-semantic");
  
  const { decision } = await callPreStep(runtime, agent, "beta explicit trigger");
  const fallback = fallbackText(decision);
  const injected = injectedSkills(decision);

  // beta-explicit should load successfully
  assert.equal(injected.map((item) => item.name).includes("beta-explicit"), true);
  // Fallback should warn about delta-semantic unavailable
  assert.equal(fallback.includes("delta-semantic"), true);
});

test("explicit trigger precedence respects slash gesture order (triggers before slash)", () => {
  const registry = {
    maxMatches: 3,
    maxFullPayloads: 3,
    skills: [
      {
        name: "trigger-priority",
        category: "test",
        description: "Trigger priority test.",
        triggers: ["trigger match"],
        payload: "SKILL.md",
      },
      {
        name: "gesture-priority",
        category: "test",
        description: "Gesture priority test.",
        payload: "SKILL.md",
      },
    ],
    categories: {
      test: {
        label: "Test",
        terms: ["test"],
        skills: ["trigger-priority", "gesture-priority"],
      },
    },
  };
  
  const route = routeQuery("/gesture-priority trigger match", registry, null);
  
  // Trigger match should take precedence over slash gesture
  assert.equal(route.status, "explicit");
  assert.equal(route.selectedNames.includes("trigger-priority"), true);
});

test("load_skill respects budget across repeated calls", async () => {
  const { runtime, agent } = await mountFixture({ maxFullPayloads: 2 });
  const loadTool = toolByName(runtime, "load_skill");
  
  // First load
  const output1 = await loadTool.execute({ name: "beta-explicit" }, { agent, signal: new AbortController().signal });
  assert.equal(output1.status, "ok");
  
  // Second load should succeed (forced + beta = 2 total)
  const output2 = await loadTool.execute({ name: "gamma-category" }, { agent, signal: new AbortController().signal });
  assert.equal(output2.status, "ok");
  
  // Third load should fail (would exceed maxFullPayloads)
  const output3 = await loadTool.execute({ name: "delta-semantic" }, { agent, signal: new AbortController().signal });
  assert.equal(output3.status, "failed");
  assert.ok(output3.warnings.length > 0, "output3.warnings should be non-empty");
  assert.equal(output3.warnings.some(w => w.includes("Payload budget exceeded")), true);
});

test("registry path escapes are rejected", async () => {
  const { runtime, agent, root } = await mountFixture();
  
  // Use path escape for registry
  apply(runtime.ctx, { 
    skillRoot: root, 
    registryFile: "../registry.json",
    categoriesFile: "../categories.json",
    alwaysAttachSkill: "forced-alpha" 
  });
  
  const { decision } = await callPreStep(runtime, agent, "beta explicit trigger");
  const fallback = fallbackText(decision);
  
  assert.equal(fallback.includes("ROUTER_STATUS"), true);
  assert.equal(fallback.includes("invalid"), true);
});

test("historical CURRENT_TASK text never restores into current context", async () => {
  const { runtime, agent } = await mountFixture();
  const messages = [
    userMessage("current query", "current-user"),
    { 
      id: "historical-task", 
      role: "user", 
      content: [{ type: "text", text: "Restore current task: BUILD_HARNESS_ORCHESTRATION_LAYER" }], 
      source: { kind: "user" } 
    },
  ];
  const { decision } = await callPreStepWithMessages(runtime, agent, messages);
  
  const fallback = fallbackText(decision);
  assert.equal(fallback.includes("BUILD_HARNESS_ORCHESTRATION_LAYER"), false);
  assert.equal(fallback.includes("Restore current task"), false);
});
