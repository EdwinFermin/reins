import {
  AGENT_ROLES,
  type AgentPolicy,
  type AgentRole,
  type CommandSpec,
  type Preset,
  type ReinsConfig,
  type Runtime,
} from "../config/schema";

export interface ResolvedCommands {
  test: string | null;
  build: string | null;
  lint: string | null;
  e2e: string | null;
  typecheck: string | null;
}

/** Per-role model/effort resolved for templates: null means inherit -> omit the field. */
export interface ResolvedAgentPolicy {
  model: string | null;
  effort: string | null;
}

/** The data object passed to every harness template (available as `it` in eta). */
export interface TemplateContext {
  harnessVersion: string;
  preset: Preset;
  isSdd: boolean;
  runtime: string;
  projectName: string;
  date: string;
  language: string;
  packageManager: string;
  frameworks: string[];
  frameworksText: string;
  commands: ResolvedCommands;
  verifyCmd: string;
  /** Claude Code `permissions.allow` allowlist (used by `.claude/settings.json`). */
  permissionsAllow: string[];
  /** opencode `permission` object (used by `opencode.json`). */
  opencodePermission: OpencodePermission;
  agents: Record<AgentRole, ResolvedAgentPolicy>;
}

export interface OpencodePermission {
  edit: "allow" | "ask" | "deny";
  webfetch: "allow" | "ask" | "deny";
  bash: Record<string, "allow" | "ask" | "deny">;
}

/**
 * Resolve a role's model for the target runtime.
 *
 * Claude Code accepts Reins aliases (`sonnet`/`opus`/…) and full model IDs.
 * opencode expects a `provider/model` string, so Reins aliases don't translate;
 * we pass through only explicit `provider/model` IDs and otherwise omit the
 * field (the agent then uses opencode's configured default). `effort` has no
 * opencode agent-frontmatter equivalent, so it is dropped there.
 */
function resolveAgentPolicy(p: AgentPolicy | undefined, runtime: Runtime): ResolvedAgentPolicy {
  const raw = p?.model && p.model !== "inherit" ? p.model : null;
  if (runtime === "opencode") {
    const model = raw && raw.includes("/") ? raw : null;
    return { model, effort: null };
  }
  return { model: raw, effort: p?.effort ?? null };
}

function commandToString(c: CommandSpec | null | undefined): string | null {
  if (c == null) return null;
  return typeof c === "string" ? c : c.cmd;
}

/** Bare command prefixes the harness should be allowed to run for the detected stack. */
function stackCommandPrefixes(language: string, pm: string): string[] {
  const prefixes = [
    "npx reins",
    "reins",
    "git status",
    "git diff",
    "git add",
    "git log",
    "git commit",
  ];

  if (language === "node") {
    const m = pm || "npm";
    prefixes.push(
      m,
      `${m} run`,
      `${m} test`,
      `${m} audit`,
      "npx vitest",
      "npx eslint",
      "npx tsc",
      "node",
    );
  } else if (language === "python") {
    const prefix = pm === "uv" ? "uv run " : pm === "poetry" ? "poetry run " : "";
    prefixes.push(
      `${prefix}pytest`,
      `${prefix}ruff`,
      `${prefix}mypy`,
      "pip-audit",
      "python",
      "python3",
    );
    if (pm === "uv") prefixes.push("uv", "uv run");
    if (pm === "poetry") prefixes.push("poetry", "poetry run");
  }

  return prefixes;
}

/** Build the Claude Code `permissions.allow` allowlist for the detected stack. */
export function buildPermissionsAllow(language: string, pm: string): string[] {
  return stackCommandPrefixes(language, pm).map((p) => `Bash(${p}:*)`);
}

/**
 * Build the opencode `permission` object for the detected stack: edit/webfetch
 * are allowed, and bash defaults to `ask` with the stack's commands allowed
 * outright — mirroring the Claude allowlist's "auto-run these, confirm the rest".
 */
export function buildOpencodePermission(language: string, pm: string): OpencodePermission {
  const bash: Record<string, "allow" | "ask" | "deny"> = { "*": "ask" };
  for (const p of stackCommandPrefixes(language, pm)) bash[`${p} *`] = "allow";
  return { edit: "allow", webfetch: "allow", bash };
}

export function buildTemplateContext(
  config: ReinsConfig,
  opts: { projectName: string; date: string },
): TemplateContext {
  const language = config.stack.language;
  const pm = config.stack.packageManager ?? "";
  const commands: ResolvedCommands = {
    test: commandToString(config.commands.test),
    build: commandToString(config.commands.build),
    lint: commandToString(config.commands.lint),
    e2e: commandToString(config.commands.e2e),
    typecheck: commandToString(config.commands.typecheck),
  };

  return {
    harnessVersion: config.harnessVersion,
    preset: config.preset,
    isSdd: config.preset === "sdd",
    runtime: config.runtime,
    projectName: opts.projectName,
    date: opts.date,
    language,
    packageManager: pm,
    frameworks: config.stack.frameworks,
    frameworksText: config.stack.frameworks.length
      ? config.stack.frameworks.join(", ")
      : "none detected",
    commands,
    verifyCmd: "npx reins verify",
    permissionsAllow: buildPermissionsAllow(language, pm),
    opencodePermission: buildOpencodePermission(language, pm),
    agents: Object.fromEntries(
      AGENT_ROLES.map((role) => [role, resolveAgentPolicy(config.agents[role], config.runtime)]),
    ) as Record<AgentRole, ResolvedAgentPolicy>,
  };
}
