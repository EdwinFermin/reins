import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReinsConfigSchema } from "../../src/core/config/schema";
import { runInit } from "../../src/core/init/run";

async function nodeProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reins-e2e-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "demo",
        scripts: { test: "vitest run", build: "tsup", lint: "eslint ." },
        devDependencies: { vitest: "^2" },
      },
      null,
      2,
    ),
  );
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("reins init — sdd on a node project", () => {
  it("scaffolds a valid harness and is idempotent on re-run", async () => {
    const cwd = await nodeProject();
    await runInit({ cwd, preset: "sdd", harnessVersion: "9.9.9", installGitHook: false });

    // Agents (valid frontmatter, restricted tools)
    const leader = await readFile(path.join(cwd, ".claude/agents/leader.md"), "utf8");
    expect(leader.startsWith("---\nname: leader")).toBe(true);
    expect(leader).toContain("tools: Read, Glob, Grep, Bash, Agent");
    expect(await exists(path.join(cwd, ".claude/agents/spec_author.md"))).toBe(true);

    // Per-role model defaults: inherit roles omit the field, cheap roles pin it.
    expect(leader).not.toContain("model:");
    expect(leader).toContain("tools: Read, Glob, Grep, Bash, Agent\n---");
    const reviewer = await readFile(path.join(cwd, ".claude/agents/reviewer.md"), "utf8");
    expect(reviewer).toContain("tools: Read, Glob, Grep, Bash\nmodel: sonnet\n---");
    const specAuthor = await readFile(path.join(cwd, ".claude/agents/spec_author.md"), "utf8");
    expect(specAuthor).toContain("model: sonnet\n---");

    // The Four R's review contract: the doc renders and is wired into both agents.
    const fourRs = await readFile(path.join(cwd, "docs/four-rs.md"), "utf8");
    expect(fourRs).toContain("# The Four R's");
    for (const r of ["Risk", "Readability", "Reliability", "Resilience"]) {
      expect(fourRs).toContain(r);
    }
    expect(reviewer).toContain("docs/four-rs.md");
    expect(reviewer).toContain("## Judgment (Four R's)");
    const implementer = await readFile(path.join(cwd, ".claude/agents/implementer.md"), "utf8");
    expect(implementer).toContain("docs/four-rs.md");
    expect(implementer).toContain("Self-review (Four R's)");

    // The brainstorm command is COMMON — present under sdd too.
    const brainstorm = await readFile(path.join(cwd, ".claude/commands/brainstorm.md"), "utf8");
    expect(brainstorm).toContain("$ARGUMENTS");
    expect(brainstorm).toContain("reins add-feature");
    // Under sdd, brainstorm carries every feature to an approved spec.
    expect(brainstorm).toContain("Spec pipeline");
    expect(brainstorm).toContain("`approved`");
    expect(brainstorm).toContain("in English");

    // autopilot is a COMMON command: the batch form of next-feature.
    const autopilot = await readFile(path.join(cwd, ".claude/commands/autopilot.md"), "utf8");
    expect(autopilot).toContain("allowed-tools: Read, Bash, Agent");
    expect(autopilot).toContain("ready queue");
    expect(autopilot).toContain("`approved`"); // sdd targets approved features

    // approve-spec now targets `approved`, not `in_progress`.
    const approveSpec = await readFile(path.join(cwd, ".claude/commands/approve-spec.md"), "utf8");
    expect(approveSpec).toContain("`approved`");
    expect(approveSpec).not.toContain("in_progress");

    // settings.json valid + hooks + stack allowlist
    const settings = JSON.parse(await readFile(path.join(cwd, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("reins verify --hook Stop");
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit");
    expect(settings.permissions.allow).toContain("Bash(npx reins:*)");
    expect(settings.permissions.allow).toContain("Bash(npm test:*)");

    // reins.config.json valid against the schema; commands inferred (no lockfile -> npm)
    const cfg = ReinsConfigSchema.parse(
      JSON.parse(await readFile(path.join(cwd, "reins.config.json"), "utf8")),
    );
    expect(cfg.preset).toBe("sdd");
    expect(cfg.commands.test).toBe("npm test");
    expect(cfg.verify.required).toContain("traceability");

    // CLAUDE.md imports AGENTS.md and is wrapped in a managed block
    const claude = await readFile(path.join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("@AGENTS.md");
    expect(claude).toContain(">>> reins >>>");

    // Living state + specs + manifest
    const featureList = JSON.parse(await readFile(path.join(cwd, "feature_list.json"), "utf8"));
    expect(featureList.rules.validStates).toContain("approved");
    expect(await exists(path.join(cwd, "progress/history.md"))).toBe(true);
    expect(await exists(path.join(cwd, "specs/_template/requirements.md"))).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(cwd, ".reins/manifest.json"), "utf8"));
    expect(manifest.files.length).toBeGreaterThan(15);
    expect(manifest.harnessVersion).toBe("9.9.9");

    // Idempotent: a second run touches nothing.
    const second = await runInit({
      cwd,
      preset: "sdd",
      harnessVersion: "9.9.9",
      installGitHook: false,
    });
    expect(second.outcomes.every((o) => o.action === "skip")).toBe(true);
  });
});

describe("reins init — lite", () => {
  it("omits sdd-only files and does not overwrite living state", async () => {
    const cwd = await nodeProject();
    await runInit({ cwd, preset: "lite", harnessVersion: "9.9.9", installGitHook: false });
    expect(await exists(path.join(cwd, ".claude/agents/spec_author.md"))).toBe(false);
    expect(await exists(path.join(cwd, "specs/_template/requirements.md"))).toBe(false);
    // The Four R's doc is runtime-neutral — present in lite too.
    expect(await exists(path.join(cwd, "docs/four-rs.md"))).toBe(true);
    // COMMON commands are present in lite too.
    expect(await exists(path.join(cwd, ".claude/commands/brainstorm.md"))).toBe(true);
    const autopilot = await readFile(path.join(cwd, ".claude/commands/autopilot.md"), "utf8");
    expect(autopilot).toContain("`pending`"); // lite targets pending features
    expect(autopilot).not.toContain("`approved`");

    // Edit living state, re-run, confirm it is preserved (create-only).
    await writeFile(
      path.join(cwd, "feature_list.json"),
      '{"version":1,"features":[{"slug":"x"}]}\n',
    );
    await runInit({ cwd, preset: "lite", harnessVersion: "9.9.9", installGitHook: false });
    const fl = await readFile(path.join(cwd, "feature_list.json"), "utf8");
    expect(fl).toContain('"slug":"x"');
  });
});

describe("reins init — opencode runtime", () => {
  it("renders the Four R's contract into the opencode agents", async () => {
    const cwd = await nodeProject();
    await runInit({
      cwd,
      preset: "sdd",
      runtime: "opencode",
      harnessVersion: "9.9.9",
      installGitHook: false,
    });
    expect(await exists(path.join(cwd, "docs/four-rs.md"))).toBe(true);
    const reviewer = await readFile(path.join(cwd, ".opencode/agents/reviewer.md"), "utf8");
    expect(reviewer).toContain("docs/four-rs.md");
    expect(reviewer).toContain("## Judgment (Four R's)");
    const implementer = await readFile(path.join(cwd, ".opencode/agents/implementer.md"), "utf8");
    expect(implementer).toContain("docs/four-rs.md");
    expect(implementer).toContain("Self-review (Four R's)");
  });
});
