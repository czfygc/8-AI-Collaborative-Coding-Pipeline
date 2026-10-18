import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const name = "skill-router";
const inject = ["skills", "tools"];
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_ALWAYS_ATTACH = "titan-quant-tool-discipline";
let messageSequence = 0;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_/\\:]+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeTokens(value) {
  return normalizeText(value).split(" ").filter((token) => token.length > 1);
}

function containsPhrase(normalized, phrase) {
  const candidate = normalizeText(phrase);
  return Boolean(candidate) && normalized.includes(candidate);
}

function compareName(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueNames(names) {
  const seen = new Set();
  const result = [];
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

function slashGestureNames(query) {
  const raw = String(query ?? "").toLowerCase();
  const names = [];
  for (const match of raw.matchAll(/(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    if (match[1] && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function safeChild(root, value, label, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty relative path`);
    return undefined;
  }
  if (isAbsolute(value)) {
    errors.push(`${label} must be relative to the Skill root`);
    return undefined;
  }
  try {
    const target = resolve(root, value);
    const relation = relative(root, target);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      errors.push(`${label} escapes the Skill root`);
      return undefined;
    }
    return target;
  } catch {
    errors.push(`${label} is not a usable path`);
    return undefined;
  }
}

function validateRegistry(raw, root) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      errors: ["registry.json must contain an object"],
      warnings,
      skills: [],
      categories: {},
      maxMatches: 3,
      maxFullPayloads: 3,
    };
  }
  if (raw.schemaVersion !== 1) errors.push("registry schemaVersion must be 1");

  const maxMatches = Number.isInteger(raw.maxMatches) ? raw.maxMatches : 3;
  const maxFullPayloads = Number.isInteger(raw.maxFullPayloads) ? raw.maxFullPayloads : 3;
  if (raw.maxMatches !== undefined && !Number.isInteger(raw.maxMatches)) errors.push("registry maxMatches must be an integer");
  if (raw.maxFullPayloads !== undefined && !Number.isInteger(raw.maxFullPayloads)) errors.push("registry maxFullPayloads must be an integer");
  if (maxMatches < 1 || maxMatches > 3) errors.push("registry maxMatches must be between 1 and 3");
  if (maxFullPayloads < 1 || maxFullPayloads > 3) errors.push("registry maxFullPayloads must be between 1 and 3");
  if (!Array.isArray(raw.skills)) {
    errors.push("registry skills must be an array");
    return { errors, warnings, skills: [], categories: {}, maxMatches, maxFullPayloads };
  }

  const skills = [];
  const names = new Set();
  let alwaysAttachCount = 0;
  for (const [index, item] of raw.skills.entries()) {
    const label = `registry.skills[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const skillName = item.name;
    if (typeof skillName !== "string" || !SKILL_NAME.test(skillName)) {
      errors.push(`${label}.name must be a valid kebab-case Skill name`);
      continue;
    }
    if (names.has(skillName)) {
      errors.push(`duplicate Skill name in registry: ${skillName}`);
      continue;
    }
    names.add(skillName);
    if (typeof item.description !== "string" || item.description.trim().length === 0) {
      errors.push(`${label}.description must be non-empty`);
    }
    if (typeof item.category !== "string" || !SKILL_NAME.test(item.category)) {
      errors.push(`${label}.category must be a valid kebab-case category name`);
    }
    const keywords = asArray(item.keywords);
    if (keywords.some((keyword) => typeof keyword !== "string" || keyword.trim().length === 0)) {
      errors.push(`${label}.keywords must contain non-empty strings`);
    }
    const triggers = asArray(item.triggers);
    if (item.triggers !== undefined && !Array.isArray(item.triggers)) {
      errors.push(`${label}.triggers must be an array`);
    }
    if (triggers.some((trigger) => typeof trigger !== "string" || trigger.trim().length === 0)) {
      errors.push(`${label}.triggers must contain non-empty strings`);
    }
    if (item.alwaysAttach !== undefined && typeof item.alwaysAttach !== "boolean") {
      errors.push(`${label}.alwaysAttach must be boolean`);
    }
    if (item.alwaysAttach === true) alwaysAttachCount += 1;
    const payload = item.payload ?? "SKILL.md";
    const payloadRoot = resolve(root, skillName);
    const payloadPath = safeChild(payloadRoot, payload, `${label}.payload`, errors);
    skills.push({
      name: skillName,
      category: typeof item.category === "string" ? item.category.trim() : "",
      description: typeof item.description === "string" ? item.description.trim() : "",
      keywords: keywords.filter((keyword) => typeof keyword === "string").map((keyword) => keyword.trim()).filter(Boolean),
      triggers: triggers.filter((trigger) => typeof trigger === "string").map((trigger) => trigger.trim()).filter(Boolean),
      alwaysAttach: item.alwaysAttach === true,
      payload,
      payloadPath,
    });
  }
  if (alwaysAttachCount > 1) warnings.push(`registry contains ${alwaysAttachCount} always-attached Skills; the configured forced Skill wins`);

  return { errors, warnings, skills, categories: {}, maxMatches, maxFullPayloads };
}

function validateCategories(raw, registry) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: ["categories.json must contain an object"], warnings, categories: {} };
  }
  if (raw.schemaVersion !== 1) errors.push("categories schemaVersion must be 1");
  if (!raw.categories || typeof raw.categories !== "object" || Array.isArray(raw.categories)) {
    errors.push("categories must be an object");
    return { errors, warnings, categories: {} };
  }

  const categories = {};
  const registryNames = new Set(registry.skills.map((skill) => skill.name));
  const memberships = new Map();
  for (const [categoryName, item] of Object.entries(raw.categories)) {
    const label = `categories.${categoryName}`;
    const categoryErrors = [];
    if (!SKILL_NAME.test(categoryName)) {
      categoryErrors.push(`${label} must be a valid kebab-case category name`);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      categoryErrors.push(`${label} must be an object`);
      errors.push(...categoryErrors);
      continue;
    }
    if (typeof item.label !== "string" || item.label.trim().length === 0) {
      categoryErrors.push(`${label}.label must be non-empty`);
    }
    const skills = asArray(item.skills);
    if (!skills.length) categoryErrors.push(`${label}.skills must not be empty`);
    if (skills.some((skillName) => typeof skillName !== "string" || !registryNames.has(skillName))) {
      categoryErrors.push(`${label}.skills contains a name absent from registry.json`);
    }
    const terms = asArray(item.terms);
    if (!terms.length) categoryErrors.push(`${label}.terms must not be empty`);
    if (terms.some((term) => typeof term !== "string" || term.trim().length === 0)) {
      categoryErrors.push(`${label}.terms must contain non-empty strings`);
    }
    errors.push(...categoryErrors);
    if (categoryErrors.length) continue;

    const uniqueSkills = [];
    const seenSkills = new Set();
    for (const skillName of skills) {
      if (seenSkills.has(skillName)) {
        errors.push(`${label}.skills contains duplicate Skill ${skillName}`);
        continue;
      }
      seenSkills.add(skillName);
      uniqueSkills.push(skillName);
      memberships.set(skillName, (memberships.get(skillName) ?? 0) + 1);
    }
    categories[categoryName] = {
      label: item.label.trim(),
      terms: terms.map((term) => term.trim()).filter(Boolean),
      skills: uniqueSkills,
    };
  }

  for (const skill of registry.skills) {
    const category = categories[skill.category];
    if (!category) {
      errors.push(`Skill ${skill.name} references missing category ${skill.category}`);
      continue;
    }
    if (!category.skills.includes(skill.name)) {
      errors.push(`Skill ${skill.name} is assigned to ${skill.category} but is absent from that category's skills list`);
    }
  }
  for (const [skillName, count] of memberships) {
    if (count > 1) errors.push(`Skill ${skillName} appears in multiple categories`);
  }
  return { errors, warnings, categories };
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { errors: [`cannot read ${label}: ${String(error)}`], warnings: [], value: undefined };
  }
  try {
    return { errors: [], warnings: [], value: JSON.parse(text) };
  } catch (error) {
    return { errors: [`invalid JSON in ${label}: ${String(error)}`], warnings: [], value: undefined };
  }
}

async function loadRegistryState(skillRoot, registryFile, categoriesFile) {
  const root = resolve(skillRoot);
  const pathErrors = [];
  
  // Default to standard paths when not explicitly configured
  let registryPath = join(root, "registry.json");
  let categoriesPath = join(root, "categories.json");
  
  // Only validate custom paths (when explicitly provided)
  if (registryFile && typeof registryFile === "string" && registryFile.trim() !== "") {
    registryPath = resolve(root, registryFile.trim());
    const relativePath = relative(root, registryPath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      pathErrors.push(`registry path escapes skillRoot`);
      registryPath = join(root, "registry.json");
    }
  }
  if (categoriesFile && typeof categoriesFile === "string" && categoriesFile.trim() !== "") {
    categoriesPath = resolve(root, categoriesFile.trim());
    const relativePath = relative(root, categoriesPath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      pathErrors.push(`categories path escapes skillRoot`);
      categoriesPath = join(root, "categories.json");
    }
  }
  
  const [registryRead, categoriesRead] = await Promise.all([
    readJson(registryPath, "registry.json"),
    readJson(categoriesPath, "categories.json"),
  ]);
  const registry = validateRegistry(registryRead.value, root);
  const categoryValidation = validateCategories(categoriesRead.value, registry);
  const validationErrors = [
    ...registryRead.errors,
    ...registry.errors,
    ...categoriesRead.errors,
    ...categoryValidation.errors,
  ];
  const warnings = [
    ...registryRead.warnings,
    ...registry.warnings,
    ...categoriesRead.warnings,
    ...categoryValidation.warnings,
  ];
  const categories = categoryValidation.categories;
  for (const skill of registry.skills) {
    if (!skill.payloadPath) continue;
    try {
      await stat(skill.payloadPath);
    } catch (error) {
      warnings.push(`payload is not readable for ${skill.name}: ${String(error)}`);
    }
  }
  const allErrors = [...pathErrors, ...validationErrors];
  const status = allErrors.length === 0 ? (warnings.length === 0 ? "ok" : "degraded") : "invalid";
  return {
    root,
    registryPath,
    categoriesPath,
    skills: registry.skills,
    categories,
    maxMatches: registry.maxMatches,
    maxFullPayloads: registry.maxFullPayloads,
    errors: allErrors,
    warnings,
    status,
  };
}

function extractUserText(messages) {
  // agent/pre-step.messages is the claimed current-step batch, not durable transcript history.
  const parts = [];
  for (const message of asArray(messages)) {
    if (message.source?.kind !== "user") continue;
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    for (const block of asArray(message.content)) {
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function isMetaQuery(query) {
  const normalized = normalizeText(query);
  return /^(list|show) (skill )?categories?$/.test(normalized)
    || /^load skill /.test(normalized)
    || /^route skills /.test(normalized);
}

function parseExplicitTrigger(query, registry) {
  const normalized = normalizeText(query);
  if (!normalized) return null;
  
  // Priority order: trigger → name → slash gesture
  for (const skill of registry.skills) {
    const trigger = (skill.triggers ?? []).find((candidate) => containsPhrase(normalized, candidate));
    if (trigger) {
      return { name: skill.name, layer: "explicit", reason: "trigger", matched: trigger };
    }
  }
  for (const skill of registry.skills) {
    if (containsPhrase(normalized, skill.name)) {
      return { name: skill.name, layer: "explicit", reason: "name", matched: skill.name };
    }
  }
  
  const gestureNames = slashGestureNames(query);
  for (const skill of registry.skills) {
    if (gestureNames.includes(skill.name)) {
      return { name: skill.name, layer: "explicit", reason: "slash-gesture", matched: `/${skill.name}` };
    }
  }
  return null;
}

function chooseExplicitMatches(query, registry, forcedName) {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  const gestureNames = slashGestureNames(query);
  const matches = [];
  for (const [index, skill] of registry.skills.entries()) {
    const trigger = (skill.triggers ?? []).find((candidate) => containsPhrase(normalized, candidate));
    if (trigger) {
      matches.push({ name: skill.name, score: 1000 - index, layer: "explicit", reason: "trigger", matched: trigger });
      continue;
    }
    if (containsPhrase(normalized, skill.name)) {
      matches.push({ name: skill.name, score: 950 - index, layer: "explicit", reason: "name", matched: skill.name });
      continue;
    }
    if (gestureNames.includes(skill.name)) {
      matches.push({ name: skill.name, score: 900 - index, layer: "explicit", reason: "slash-gesture", matched: `/${skill.name}` });
    }
  }
  return matches.sort((left, right) => right.score - left.score || compareName(left.name, right.name));
}

function categoryMatch(query, category) {
  const normalized = normalizeText(query);
  if (!normalized) return null;
  const terms = [category?.label, ...(category?.terms ?? [])].map((term) => String(term ?? "")).filter(Boolean);
  const hits = terms.filter((term) => containsPhrase(normalized, term));
  if (!hits.length) return null;
  const tokens = normalizeTokens(query);
  const tokenCoverage = tokens.length
    ? tokens.filter((token) => terms.some((term) => normalizeText(term).includes(token))).length / tokens.length
    : 0;
  return {
    score: hits.length * 20 + Math.round(tokenCoverage * 10),
    hits,
  };
}

function chooseCategoryMatches(query, registry, forcedName, selectedNames) {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  const selected = new Set(selectedNames);
  const candidates = [];
  const categoryEntries = Object.entries(registry.categories)
    .filter(([, category]) => category && Array.isArray(category.skills))
    .sort(([left], [right]) => compareName(left, right));
  for (const [categoryName, category] of categoryEntries) {
    const matched = categoryMatch(query, category);
    if (!matched) continue;
    for (const [skillIndex, skillName] of category.skills.entries()) {
      if (skillName === forcedName || selected.has(skillName)) continue;
      candidates.push({
        name: skillName,
        score: matched.score,
        layer: "category",
        reason: `category:${categoryName}`,
        category: categoryName,
        categoryScore: matched.score,
        categoryHits: matched.hits,
        order: skillIndex,
      });
    }
  }
  return candidates.sort((left, right) =>
    right.categoryScore - left.categoryScore
    || compareName(left.category ?? "", right.category ?? "")
    || left.order - right.order
    || compareName(left.name, right.name));
}

function semanticScore(query, skill) {
  const normalized = normalizeText(query);
  if (!normalized) return 0;
  const tokens = normalizeTokens(query);
  if (!tokens.length) return 0;
  const fields = [skill?.description, ...(skill?.keywords ?? [])].map((value) => normalizeText(value)).filter(Boolean);
  let score = 0;
  for (const field of fields) {
    if (field.length >= 4 && containsPhrase(normalized, field)) score += field.length >= 10 ? 8 : 4;
  }
  const matchedTokens = tokens.filter((token) => fields.some((field) => field.includes(token)));
  score += Math.round((matchedTokens.length / tokens.length) * 10);
  return score >= 2 ? score : 0;
}

function chooseSemanticMatches(query, registry, forcedName, selectedNames) {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  const selected = new Set(selectedNames);
  return registry.skills
    .filter((skill) => skill.name !== forcedName && !selected.has(skill.name))
    .map((skill) => ({
      name: skill.name,
      score: semanticScore(query, skill),
      layer: "semantic",
      reason: "metadata-overlap",
      category: skill.category,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || compareName(left.name, right.name));
}

function routeQuery(query, registry, forcedName) {
  const normalized = normalizeText(query);
  const forcedCount = forcedName ? 1 : 0;
  const routeLimit = Math.max(0, Math.min(registry.maxMatches, registry.maxFullPayloads - forcedCount));
  const audit = {
    query,
    normalized,
    inputBoundary: "agent/pre-step claimed current-step messages",
    forcedName: forcedName ?? null,
    limits: {
      maxMatches: registry.maxMatches,
      maxFullPayloads: registry.maxFullPayloads,
      forcedCount,
      optionalRouteLimit: routeLimit,
    },
    layers: [],
    selectedNames: [],
    status: normalized ? "no-match" : "no-query",
  };
  const selectedNames = forcedName ? [forcedName] : [];
  if (!normalized) {
    if (forcedName) {
      audit.layers.push({
        layer: "alwaysAttach",
        selected: [forcedName],
        candidates: [{ name: forcedName, score: null, reason: "configured-or-registry-forced" }],
      });
      audit.selectedNames = selectedNames.slice(0, registry.maxFullPayloads);
      audit.status = "forced-only";
    }
    return audit;
  }
  if (isMetaQuery(query)) {
    audit.status = "meta-query";
    return audit;
  }

  if (forcedName) {
    audit.layers.push({
      layer: "alwaysAttach",
      selected: [forcedName],
      candidates: [{ name: forcedName, score: null, reason: "configured-or-registry-forced" }],
    });
  }

  const explicitMatches = chooseExplicitMatches(query, registry, forcedName);
  const explicitSelected = [];
  for (const candidate of explicitMatches) {
    if (selectedNames.includes(candidate.name)) {
      if (!explicitSelected.includes(candidate.name)) explicitSelected.push(candidate.name);
      continue;
    }
    if (selectedNames.length - forcedCount >= routeLimit) break;
    selectedNames.push(candidate.name);
    explicitSelected.push(candidate.name);
  }
  audit.layers.push({ layer: "explicit", selected: explicitSelected, candidates: explicitMatches });

  // An explicit trigger is terminal for optional routing: category and semantic evidence may not dilute it.
  const categoryMatches = chooseCategoryMatches(query, registry, forcedName, selectedNames);
  const categorySelected = [];
  if (!explicitSelected.length) {
    for (const candidate of categoryMatches) {
      if (selectedNames.length - forcedCount >= routeLimit) break;
      if (selectedNames.includes(candidate.name)) continue;
      selectedNames.push(candidate.name);
      categorySelected.push(candidate.name);
    }
  }
  audit.layers.push({ layer: "category", selected: categorySelected, candidates: categoryMatches });

  const semanticMatches = chooseSemanticMatches(query, registry, forcedName, selectedNames);
  const semanticSelected = [];
  if (!explicitSelected.length && !categorySelected.length) {
    for (const candidate of semanticMatches) {
      if (selectedNames.length - forcedCount >= routeLimit) break;
      if (selectedNames.includes(candidate.name)) continue;
      selectedNames.push(candidate.name);
      semanticSelected.push(candidate.name);
    }
  }
  audit.layers.push({ layer: "semantic", selected: semanticSelected, candidates: semanticMatches });

  audit.selectedNames = selectedNames.slice(0, registry.maxFullPayloads);
  audit.status = explicitSelected.length
    ? "explicit"
    : categorySelected.length
      ? "category"
      : semanticSelected.length
        ? "semantic"
        : forcedName
          ? "forced-only"
          : "no-match";
  return audit;
}

function chooseMatches(query, registry, forcedName) {
  return routeQuery(query, registry, forcedName).selectedNames.filter((name) => name !== forcedName);
}

function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeText(value).replaceAll("\"", "&quot;");
}

function renderSkillContent(skill) {
  const resourceHint = skill.resourceBase?.kind === "directory"
    ? [`Base directory for this skill: ${escapeText(skill.resourceBase.path)}`, "Resolve relative paths mentioned by this skill against the base directory before using them."]
    : skill.resourceBase?.kind === "url"
      ? [`Base URL for this skill: ${escapeText(skill.resourceBase.url)}`, "Resolve relative URLs mentioned by this skill against the base URL before using them."]
      : [`Resources for this skill are managed by provider "${escapeText(skill.provider)}".`, "Load referenced resources only as needed."];
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    "<skill_resources>",
    ...resourceHint,
    "</skill_resources>",
    "",
    "<skill_instructions>",
    skill.content,
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
}

function makeUserMessage(text, source) {
  const randomUUID = globalThis.crypto?.randomUUID;
  const id = typeof randomUUID === "function"
    ? `skill-router-${randomUUID.call(globalThis.crypto)}`
    : `skill-router-${Date.now()}-${messageSequence++}`;
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source,
  };
}

function skillMessage(skill, routeLayer = "unknown") {
  return makeUserMessage(renderSkillContent(skill), {
    kind: "skill-router",
    name: skill.name,
    form: "instructions",
    route: { layer: routeLayer, inputBoundary: "agent/pre-step claimed current-step messages" },
  });
}

function fallbackMessage(warnings, details) {
  const limited = warnings.slice(0, 5);
  const route = details.route;
  return makeUserMessage([
    "<skill-router-fallback>",
    "ROUTING_FALLBACK = ACTIVE",
    `ROUTE_MATCHES = ${details.routedMatches}`,
    `ROUTE_LAYER = ${route?.status ?? "unknown"}`,
    `ROUTE_SELECTED = ${(route?.selectedNames ?? []).join(",") || "NONE"}`,
    `FORCED_SKILL = ${details.forcedSkill ?? "NONE"}`,
    `ROUTER_STATUS = ${details.status}`,
    `ROUTE_INPUT_BOUNDARY = ${route?.inputBoundary ?? "unknown"}`,
    "DEDICATED_TOOL = UNKNOWN",
    "Use model reasoning only for optional routing. Do not treat this notice as a successful optional Skill load.",
    ...limited.map((warning) => `Router warning: ${warning}`),
    "For quantitative claims, preserve UNKNOWN unless a dedicated tool succeeds. If a dedicated tool fails, report DEDICATED_TOOL = FAILED, name the tool and error, and state the fallback limitation.",
    "</skill-router-fallback>",
  ].join("\n"), { kind: "skill-router-fallback", form: "instructions" });
}

function auditMessage(route) {
  const layers = route.layers.map((layer) => layer.layer).filter(Boolean);
  const selectedNames = route.selectedNames;
  const limits = route.limits;
  const inputBoundary = route.inputBoundary;
  return makeUserMessage([
    "<skill-router-audit>",
    `status = ${route.status}`,
    `layers = ${layers.join(",")}`,
    `selectedNames = ${selectedNames.join(",")}`,
    `limits.maxMatches = ${limits.maxMatches}`,
    `limits.maxFullPayloads = ${limits.maxFullPayloads}`,
    `limits.forcedCount = ${limits.forcedCount}`,
    `limits.optionalRouteLimit = ${limits.optionalRouteLimit}`,
    `inputBoundary = ${inputBoundary}`,
    "</skill-router-audit>",
  ].join("\n"), { kind: "skill-router-audit", form: "instructions" });
}

function lookupOptions(agent, signal) {
  return {
    cwd: agent?.session?.header?.cwd,
    signal,
    scope: agent,
  };
}

function toolSchema(properties, required) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required?.length ? { required } : {}),
  };
}

function defineCategoryTool(getRegistry, getAvailability, configuredAlwaysAttach) {
  return {
    name: "list_skill_categories",
    description: "List compact Skill categories and registry metadata without loading full Skill payloads. Use this to discover routing categories before loading a Skill.",
    parameters: toolSchema({
      query: { type: "string", description: "Optional category or routing-term filter." },
    }, []),
    output: {
      schema: toolSchema({
        status: { type: "string" },
        maxMatches: { type: "integer" },
        maxFullPayloads: { type: "integer" },
        alwaysAttachSkill: { type: "string" },
        categories: {
          type: "array",
          items: toolSchema({
            name: { type: "string" },
            label: { type: "string" },
            skillCount: { type: "integer" },
            skills: { type: "array", items: { type: "string" } },
            terms: { type: "array", items: { type: "string" } },
          }, ["name", "label", "skillCount", "skills", "terms"]),
        },
        availableSkills: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
      }, ["status", "maxMatches", "maxFullPayloads", "alwaysAttachSkill", "categories", "availableSkills", "warnings"]),
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const registry = await getRegistry();
      const availability = await getAvailability(exec?.agent, exec?.signal);
      const filter = normalizeText(args.query);
      const categories = Object.entries(registry.categories)
        .filter(([, category]) => {
          if (!filter) return true;
          return normalizeText(category.label).includes(filter)
            || category.terms.some((term) => normalizeText(term).includes(filter))
            || category.skills.some((skillName) => normalizeText(skillName).includes(filter));
        })
        .map(([categoryName, category]) => ({
          name: categoryName,
          label: category.label,
          skillCount: category.skills.length,
          skills: category.skills,
          terms: category.terms,
        }));
      return {
        status: registry.status,
        maxMatches: registry.maxMatches,
        maxFullPayloads: registry.maxFullPayloads,
        alwaysAttachSkill: configuredAlwaysAttach,
        categories,
        availableSkills: [...availability.names].sort(),
        warnings: [...registry.errors, ...registry.warnings, ...availability.warnings],
      };
    },
  };
}

function defineLoadSkillTool(ctx, getRegistry, getAvailability, getState) {
  return {
    name: "load_skill",
    description: "Load one full Skill payload by exact registry name. The router validates the name against L0/L1 metadata and loads at most the configured progressive-disclosure limit.",
    parameters: toolSchema({
      name: { type: "string", description: "Exact Skill name from the registry or category listing." },
    }, ["name"]),
    output: {
      schema: toolSchema({
        status: { type: "string" },
        name: { type: "string" },
        category: { type: "string" },
        source: { type: "string" },
        provider: { type: "string" },
        content: { type: "string" },
        resourceBase: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string" },
            path: { type: "string" },
            url: { type: "string" },
            description: { type: "string" },
          },
          required: ["kind"],
        },
        routing: toolSchema({
          level: { type: "string" },
          matched: { type: "boolean" },
        }, ["level", "matched"]),
        warnings: { type: "array", items: { type: "string" } },
      }, ["status", "name", "category", "source", "provider", "content", "routing", "warnings"]),
      render: (_args, value) => {
        if (value.status !== "ok") {
          return [{ type: "text", text: `<skill-router-fallback>\nLOAD_SKILL = FAILED\nSKILL = ${escapeAttr(value.name)}\nERROR = ${escapeText(value.content)}\nDEDICATED_TOOL = UNKNOWN\n</skill-router-fallback>` }];
        }
        return [{ type: "text", text: renderSkillContent(value) }];
      },
    },
    async execute(args, exec) {
      const requested = String(args.name ?? "").trim();
      if (!SKILL_NAME.test(requested)) {
        return {
          status: "failed", name: requested, category: "unknown", source: "router-registry", provider: "unknown",
          content: `invalid Skill name: ${requested}`, routing: { level: "explicit", matched: false },
          warnings: ["preserve UNKNOWN when registry validation fails"],
        };
      }
      const registry = await getRegistry();
      const agent = exec?.agent;
      const state = getState(agent);
      // Reserve a direct on-demand load if the agent still has payload budget.
      if (!state.reservedNames.has(requested)) {
        if (state.reservedNames.size >= registry.maxFullPayloads) {
          return {
            status: "failed", name: requested, category: "unknown", source: "router-registry", provider: "unknown",
            content: `Payload budget exceeded: maxFullPayloads = ${registry.maxFullPayloads}`, routing: { level: "explicit", matched: false },
            warnings: ["Payload budget exceeded; preserve UNKNOWN and use model fallback"],
          };
        }
        state.reservedNames.add(requested);
      }
      // Check if already loaded.
      if (state.payloads.has(requested)) {
        const cached = state.payloads.get(requested);
        return {
          status: "ok", name: cached.name, category: skill.category, source: "router-registry", provider: cached.provider ?? "unknown",
          content: cached.content, resourceBase: cached.resourceBase,
          routing: { level: "explicit", matched: true }, warnings: [],
        };
      }
      const skill = registry.skills.find((candidate) => candidate.name === requested);
      if (!skill) {
        return {
          status: "failed", name: requested, category: "unknown", source: "router-registry", provider: "unknown",
          content: `Skill ${requested} is not present in the router registry`, routing: { level: "explicit", matched: false },
          warnings: ["preserve UNKNOWN and use model fallback"],
        };
      }
      const availability = await getAvailability(agent, exec?.signal);
      if (!availability.names.has(requested)) {
        return {
          status: "failed", name: requested, category: skill.category, source: skill.payload ?? "SKILL.md", provider: "unknown",
          content: `Skill ${requested} is registered in router metadata but unavailable from ctx.skills`, routing: { level: "explicit", matched: false },
          warnings: [...registry.warnings, ...availability.warnings, "preserve UNKNOWN and use model fallback"],
        };
      }
      try {
        const loaded = await ctx.skills.get(requested, lookupOptions(agent, exec?.signal));
        if (!loaded) throw new Error("ctx.skills.get returned no payload");
        state.payloads.set(requested, loaded);
        return {
          status: "ok", name: loaded.name, category: skill.category, source: loaded.source ?? skill.payload,
          provider: loaded.provider ?? "unknown", content: loaded.content, resourceBase: loaded.resourceBase,
          routing: { level: "explicit", matched: true }, warnings: [...registry.warnings, ...availability.warnings],
        };
      } catch (error) {
        return {
          status: "failed", name: requested, category: skill.category, source: skill.payload ?? "SKILL.md", provider: "unknown",
          content: `Skill ${requested} disappeared before full payload loading: ${String(error)}`, routing: { level: "explicit", matched: false },
          warnings: [...registry.warnings, ...availability.warnings, `preserve UNKNOWN: ${String(error)}`],
        };
      }
    },
  };
}

function apply(ctx, config = {}) {
  if (typeof config.skillRoot !== "string" || config.skillRoot.trim().length === 0) {
    throw new Error("skill-router requires config.skillRoot");
  }
  const skillRoot = resolve(config.skillRoot);
  const registryFile = typeof config.registryFile === "string" && config.registryFile ? config.registryFile : "registry.json";
  const categoriesFile = typeof config.categoriesFile === "string" && config.categoriesFile ? config.categoriesFile : "categories.json";
  const configuredAlwaysAttach = typeof config.alwaysAttachSkill === "string" ? config.alwaysAttachSkill.trim() : DEFAULT_ALWAYS_ATTACH;
  let registryPromise;
  const availabilityByAgent = new WeakMap();
  const budgetByAgent = new WeakMap();

  function getState(agent) {
    if (!agent) return { reservedNames: new Set(), payloads: new Map(), injectedNames: new Set(), fallbackDigest: "", auditKeys: new Set() };
    const cached = budgetByAgent.get(agent);
    if (cached) return cached;
    const state = { reservedNames: new Set(), payloads: new Map(), injectedNames: new Set(), fallbackDigest: "", auditKeys: new Set() };
    budgetByAgent.set(agent, state);
    return state;
  }

  async function getRegistry() {
    if (!registryPromise) {
      registryPromise = loadRegistryState(skillRoot, registryFile, categoriesFile).catch((error) => ({
        root: skillRoot,
        registryPath: resolve(skillRoot, registryFile),
        categoriesPath: resolve(skillRoot, categoriesFile),
        skills: [],
        categories: {},
        maxMatches: 1,
        maxFullPayloads: 3,
        errors: [`router initialization failed: ${String(error)}`],
        warnings: [],
        status: "invalid",
      }));
    }
    return registryPromise;
  }

  async function getAvailability(agent, signal) {
    if (!agent) return { names: new Set(), warnings: ["agent scope is unavailable"] };
    const cached = availabilityByAgent.get(agent);
    if (cached) return cached;
    let names = new Set();
    const warnings = [];
    try {
      const listed = await ctx.skills.list(lookupOptions(agent, signal));
      const summaries = Array.isArray(listed) ? listed : asArray(listed?.candidates ?? listed?.skills);
      for (const skill of summaries) {
        if (typeof skill?.name !== "string") continue;
        if (skill.invocation?.modelInvocable === false) continue;
        names.add(skill.name);
      }
      if (listed && typeof listed === "object" && listed.complete === false) {
        warnings.push("ctx.skills.list returned an incomplete catalog");
      }
    } catch (error) {
      warnings.push(`ctx.skills.list failed: ${String(error)}`);
    }
    const result = { names, warnings };
    availabilityByAgent.set(agent, result);
    return result;
  }

  function resolveForcedName(registry) {
    if (registry.skills.some((skill) => skill.name === configuredAlwaysAttach)) return configuredAlwaysAttach;
    return registry.skills.find((skill) => skill.alwaysAttach)?.name;
  }

  function chooseMatches(query, registry, forcedName) {
    return routeQuery(query, registry, forcedName).selectedNames.filter((name) => name !== forcedName);
  }

  async function routePreStep(payload, next) {
    // next() delegates the remaining pre-step waterfall; it does not execute the agent task.
    const decision = await next();
    if (decision.kind === "reject") return decision;
    const { agent, messages, signal } = payload;
    if (!agent) return decision;
    signal?.throwIfAborted();

    const registry = await getRegistry();
    const query = extractUserText(messages);
    const forcedName = resolveForcedName(registry);
    const route = routeQuery(query, registry, forcedName);
    if (registry.status !== "ok") route.status = registry.status;
    const selectedNames = registry.status === "ok" ? route.selectedNames : [];
    const loaded = new Map();
    const warnings = [...registry.errors, ...registry.warnings];
    if (configuredAlwaysAttach && !registry.skills.some((skill) => skill.name === configuredAlwaysAttach)) {
      warnings.push(`configured always-attached Skill ${configuredAlwaysAttach} is absent from the registry`);
    }
    const lookup = lookupOptions(agent, signal);
    const state = getState(agent);
    const namesToLoad = selectedNames.filter((skillName) => !state.payloads.has(skillName));

    // Reserve all selected names to enforce maxFullPayloads across route and tool calls.
    for (const skillName of selectedNames) {
      state.reservedNames.add(skillName);
    }

    // Full payloads are fetched only for skills that have not already been loaded for this agent.
    for (const skillName of namesToLoad) {
      try {
        const skill = await ctx.skills.get(skillName, lookup);
        if (!skill) throw new Error("ctx.skills.get returned no payload");
        loaded.set(skillName, skill);
        state.payloads.set(skillName, skill);
      } catch (error) {
        warnings.push(`full payload unavailable for ${skillName}: ${String(error)}`);
      }
    }

    const availability = await getAvailability(agent, signal);
    for (const skillName of selectedNames) {
      if (!availability.names.has(skillName)) warnings.push(`registry Skill ${skillName} is not available in ctx.skills`);
    }
    for (const skill of registry.skills) {
      if (!availability.names.has(skill.name)) warnings.push(`registry consistency: ${skill.name} is absent from ctx.skills`);
    }

    const injections = [];
    for (const skillName of selectedNames) {
      if (state.injectedNames.has(skillName) || !state.payloads.has(skillName)) continue;
      const layer = route.layers.find((entry) => entry.selected?.includes(skillName))?.layer ?? "alwaysAttach";
      injections.push(skillMessage(state.payloads.get(skillName), layer));
      state.injectedNames.add(skillName);
    }

    const forcedCount = forcedName ? 1 : 0;
    const optionalMatches = selectedNames.length - forcedCount;
    const noOptionalRoute = !isMetaQuery(query) && query.length > 0 && optionalMatches === 0 && route.status === "forced-only";
    const fallbackNeeded = registry.status !== "ok" || noOptionalRoute || warnings.length > 0;
    const fallbackDigest = JSON.stringify({ warnings, status: route.status, selectedNames });
    if (fallbackNeeded && !isMetaQuery(query) && state.fallbackDigest !== fallbackDigest) {
      injections.push(fallbackMessage(warnings, {
        routedMatches: optionalMatches,
        forcedSkill: forcedName ?? "NONE",
        status: registry.status,
        route,
      }));
      state.fallbackDigest = fallbackDigest;
    }
    const auditKey = isMetaQuery(query) ? "audit:meta:" : "audit:";
    if (!state.auditKeys.has(auditKey + JSON.stringify(route.selectedNames))) {
      injections.push(auditMessage(route));
      state.auditKeys.add(auditKey + JSON.stringify(route.selectedNames));
    }
    if (!injections.length) return decision;
    return { ...decision, messages: [...(decision.messages ?? []), ...injections] };
  }

  ctx.tools.register(defineCategoryTool(getRegistry, getAvailability, configuredAlwaysAttach));
  ctx.tools.register(defineLoadSkillTool(ctx, getRegistry, getAvailability, getState));
  ctx.on("agent/pre-step", routePreStep);
}

export { apply, inject, name, extractUserText, parseExplicitTrigger, routeQuery, chooseMatches, normalizeText };
