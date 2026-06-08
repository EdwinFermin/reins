import type { ReinsConfig } from "../config/schema";
import type { FileKind, RenderedFile } from "../fs/idempotent-write";
import type { TemplateContext } from "./context";
import { renderFile } from "./engine";

interface TemplateEntry {
  id: string;
  template: string;
  dest: string;
  kind?: FileKind;
}

const COMMON: TemplateEntry[] = [
  {
    id: "agent-leader",
    template: "common/.claude/agents/leader.md.eta",
    dest: ".claude/agents/leader.md",
  },
  {
    id: "agent-implementer",
    template: "common/.claude/agents/implementer.md.eta",
    dest: ".claude/agents/implementer.md",
  },
  {
    id: "agent-reviewer",
    template: "common/.claude/agents/reviewer.md.eta",
    dest: ".claude/agents/reviewer.md",
  },
  {
    id: "agent-security-reviewer",
    template: "common/.claude/agents/security-reviewer.md.eta",
    dest: ".claude/agents/security-reviewer.md",
  },
  {
    id: "cmd-verify",
    template: "common/.claude/commands/reins-verify.md.eta",
    dest: ".claude/commands/reins-verify.md",
  },
  {
    id: "cmd-status",
    template: "common/.claude/commands/reins-status.md.eta",
    dest: ".claude/commands/reins-status.md",
  },
  {
    id: "cmd-next",
    template: "common/.claude/commands/next-feature.md.eta",
    dest: ".claude/commands/next-feature.md",
  },
  { id: "claude-md", template: "common/CLAUDE.md.eta", dest: "CLAUDE.md", kind: "claude-md" },
  { id: "agents-md", template: "common/AGENTS.md.eta", dest: "AGENTS.md" },
  { id: "checkpoints", template: "common/CHECKPOINTS.md.eta", dest: "CHECKPOINTS.md" },
  {
    id: "docs-architecture",
    template: "common/docs/architecture.md.eta",
    dest: "docs/architecture.md",
  },
  {
    id: "docs-conventions",
    template: "common/docs/conventions.md.eta",
    dest: "docs/conventions.md",
  },
  {
    id: "docs-verification",
    template: "common/docs/verification.md.eta",
    dest: "docs/verification.md",
  },
  { id: "docs-security", template: "common/docs/security.md.eta", dest: "docs/security.md" },
  {
    id: "progress-current",
    template: "common/progress/current.md.eta",
    dest: "progress/current.md",
    kind: "create-only",
  },
  {
    id: "progress-history",
    template: "common/progress/history.md.eta",
    dest: "progress/history.md",
    kind: "create-only",
  },
  { id: "gitignore", template: "common/gitignore.eta", dest: ".gitignore", kind: "gitignore" },
  {
    id: "ci",
    template: "common/ci/reins-verify.yml.eta",
    dest: ".github/workflows/reins-verify.yml",
    kind: "ci-workflow",
  },
  { id: "precommit", template: "common/hooks/pre-commit.eta", dest: ".reins/hooks/pre-commit" },
];

const SDD: TemplateEntry[] = [
  {
    id: "agent-spec-author",
    template: "sdd/.claude/agents/spec_author.md.eta",
    dest: ".claude/agents/spec_author.md",
  },
  {
    id: "cmd-new-spec",
    template: "sdd/.claude/commands/new-spec.md.eta",
    dest: ".claude/commands/new-spec.md",
  },
  {
    id: "cmd-approve-spec",
    template: "sdd/.claude/commands/approve-spec.md.eta",
    dest: ".claude/commands/approve-spec.md",
  },
  {
    id: "cmd-validate-discovery",
    template: "sdd/.claude/commands/validate-discovery.md.eta",
    dest: ".claude/commands/validate-discovery.md",
  },
  { id: "docs-sdd", template: "sdd/docs/sdd-workflow.md.eta", dest: "docs/sdd-workflow.md" },
  {
    id: "spec-discovery",
    template: "sdd/specs/_template/discovery.md.eta",
    dest: "specs/_template/discovery.md",
  },
  {
    id: "spec-requirements",
    template: "sdd/specs/_template/requirements.md.eta",
    dest: "specs/_template/requirements.md",
  },
  {
    id: "spec-design",
    template: "sdd/specs/_template/design.md.eta",
    dest: "specs/_template/design.md",
  },
  {
    id: "spec-tasks",
    template: "sdd/specs/_template/tasks.md.eta",
    dest: "specs/_template/tasks.md",
  },
];

/** The Claude Code `settings.json` object (hooks + stack-aware permission allowlist). */
export function buildSettings(ctx: TemplateContext): unknown {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [
            {
              type: "command",
              command: "npx reins verify --hook PostToolUse --changed",
              timeout: 120,
            },
          ],
        },
      ],
      Stop: [
        { hooks: [{ type: "command", command: "npx reins verify --hook Stop", timeout: 300 }] },
      ],
      SubagentStop: [
        {
          hooks: [
            {
              type: "command",
              command: "npx reins telemetry record --hook SubagentStop",
              timeout: 20,
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            { type: "command", command: "npx reins status --hook SessionStart", timeout: 20 },
          ],
        },
      ],
    },
    permissions: { allow: ctx.permissionsAllow },
  };
}

/** The initial feature_list.json state machine. */
export function buildInitialFeatureList(): unknown {
  return {
    version: 1,
    rules: {
      oneFeatureInProgress: true,
      requireTestsToClose: true,
      validStates: [
        "pending",
        "analyzing",
        "needs_clarification",
        "spec_ready",
        "in_progress",
        "done",
        "blocked",
      ],
    },
    features: [],
  };
}

/** Render every file the harness installs for the given context + preset. */
export function buildHarnessFiles(config: ReinsConfig, ctx: TemplateContext): RenderedFile[] {
  const entries = [...COMMON, ...(ctx.isSdd ? SDD : [])];
  const data = ctx as unknown as Record<string, unknown>;

  const files: RenderedFile[] = entries.map((entry) => ({
    templateId: entry.id,
    destRel: entry.dest,
    content: renderFile(entry.template, data),
    kind: entry.kind ?? "plain",
  }));

  files.push({
    templateId: "settings",
    destRel: ".claude/settings.json",
    kind: "settings-json",
    content: JSON.stringify(buildSettings(ctx), null, 2) + "\n",
  });
  files.push({
    templateId: "reins-config",
    destRel: "reins.config.json",
    kind: "create-only",
    content: JSON.stringify(config, null, 2) + "\n",
  });
  files.push({
    templateId: "feature-list",
    destRel: "feature_list.json",
    kind: "create-only",
    content: JSON.stringify(buildInitialFeatureList(), null, 2) + "\n",
  });

  return files;
}
