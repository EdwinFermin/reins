import type { CommandSpec, Preset, ReinsConfig } from "../config/schema";

export interface ResolvedCommands {
  test: string | null;
  build: string | null;
  lint: string | null;
  e2e: string | null;
  typecheck: string | null;
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
  permissionsAllow: string[];
}

function commandToString(c: CommandSpec | null | undefined): string | null {
  if (c == null) return null;
  return typeof c === "string" ? c : c.cmd;
}

/** Build the Claude Code `permissions.allow` allowlist for the detected stack. */
export function buildPermissionsAllow(language: string, pm: string): string[] {
  const allow = [
    "Bash(npx reins:*)",
    "Bash(reins:*)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git add:*)",
    "Bash(git log:*)",
    "Bash(git commit:*)",
  ];

  if (language === "node") {
    const m = pm || "npm";
    allow.push(
      `Bash(${m}:*)`,
      `Bash(${m} run:*)`,
      `Bash(${m} test:*)`,
      `Bash(${m} audit:*)`,
      "Bash(npx vitest:*)",
      "Bash(npx eslint:*)",
      "Bash(npx tsc:*)",
      "Bash(node:*)",
    );
  } else if (language === "python") {
    const prefix = pm === "uv" ? "uv run " : pm === "poetry" ? "poetry run " : "";
    allow.push(
      `Bash(${prefix}pytest:*)`,
      `Bash(${prefix}ruff:*)`,
      `Bash(${prefix}mypy:*)`,
      "Bash(pip-audit:*)",
      "Bash(python:*)",
      "Bash(python3:*)",
    );
    if (pm === "uv") allow.push("Bash(uv:*)", "Bash(uv run:*)");
    if (pm === "poetry") allow.push("Bash(poetry:*)", "Bash(poetry run:*)");
  }

  return allow;
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
  };
}
