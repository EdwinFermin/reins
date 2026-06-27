import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReinsConfigSchema } from "../../src/core/config/schema";
import { runInit } from "../../src/core/init/run";

async function nodeProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reins-e2e-oc-"));
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

describe("reins init — opencode runtime (sdd)", () => {
  it("scaffolds an opencode-native harness with no Claude tree, idempotently", async () => {
    const cwd = await nodeProject();
    await runInit({
      cwd,
      preset: "sdd",
      runtime: "opencode",
      harnessVersion: "9.9.9",
      installGitHook: false,
    });

    // Agents live under .opencode/agents with opencode frontmatter.
    const leader = await readFile(path.join(cwd, ".opencode/agents/leader.md"), "utf8");
    expect(leader).toContain("mode: primary");
    expect(leader).toContain("write: false");
    expect(leader).not.toContain("name: leader"); // opencode identifies agents by filename
    expect(await exists(path.join(cwd, ".opencode/agents/spec_author.md"))).toBe(true);

    // Reins aliases don't translate to opencode, so cheap-role aliases are omitted.
    const reviewer = await readFile(path.join(cwd, ".opencode/agents/reviewer.md"), "utf8");
    expect(reviewer).toContain("mode: subagent");
    expect(reviewer.slice(0, reviewer.indexOf("\n---", 3))).not.toContain("model:");

    // The design-reviewer renders with opencode frontmatter (mode, no name, alias omitted).
    const designReviewer = await readFile(
      path.join(cwd, ".opencode/agents/design-reviewer.md"),
      "utf8",
    );
    expect(designReviewer).toContain("mode: subagent");
    expect(designReviewer).not.toContain("name: design-reviewer");
    expect(designReviewer.slice(0, designReviewer.indexOf("\n---", 3))).not.toContain("model:");
    expect(await exists(path.join(cwd, "docs/design.md"))).toBe(true);
    expect(await exists(path.join(cwd, "docs/motion.md"))).toBe(true);
    expect(await exists(path.join(cwd, ".opencode/commands/design-audit.md"))).toBe(true);

    // Commands under .opencode/commands, with opencode argument syntax.
    const brainstorm = await readFile(path.join(cwd, ".opencode/commands/brainstorm.md"), "utf8");
    expect(brainstorm).toContain("$ARGUMENTS");
    expect(brainstorm).toContain("Spec pipeline");
    expect(await exists(path.join(cwd, ".opencode/commands/approve-spec.md"))).toBe(true);

    // autopilot is a COMMON command: the batch form of next-feature.
    const autopilot = await readFile(path.join(cwd, ".opencode/commands/autopilot.md"), "utf8");
    expect(autopilot).toContain("ready queue");
    expect(autopilot).toContain("`approved`"); // sdd targets approved features
    expect(autopilot).toContain("npx reins verify");

    // The verify gate is wired through the auto-loaded plugin.
    const plugin = await readFile(path.join(cwd, ".opencode/plugins/reins-verify.ts"), "utf8");
    expect(plugin).toContain("npx reins");
    expect(plugin).toContain("session.idle");
    expect(plugin).toContain("file.edited");

    // opencode.json is valid and carries the stack-aware permission policy.
    const oc = JSON.parse(await readFile(path.join(cwd, "opencode.json"), "utf8"));
    expect(oc.$schema).toBe("https://opencode.ai/config.json");
    expect(oc.instructions).toContain("AGENTS.md");
    expect(oc.permission.bash["*"]).toBe("ask");
    expect(oc.permission.bash["npx reins *"]).toBe("allow");
    expect(oc.permission.bash["npm test *"]).toBe("allow");

    // AGENTS.md is the rules file: it carries the leader contract, in a managed block.
    const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("Orchestrate, do not implement");
    expect(agents).toContain("opencode runtime");
    expect(agents).toContain(">>> reins >>>");

    // No Claude tree is emitted for the opencode runtime.
    expect(await exists(path.join(cwd, ".claude"))).toBe(false);
    expect(await exists(path.join(cwd, "CLAUDE.md"))).toBe(false);
    expect(await exists(path.join(cwd, ".claude/settings.json"))).toBe(false);

    // Config + manifest record the runtime.
    const cfg = ReinsConfigSchema.parse(
      JSON.parse(await readFile(path.join(cwd, "reins.config.json"), "utf8")),
    );
    expect(cfg.runtime).toBe("opencode");
    expect(cfg.preset).toBe("sdd");
    const manifest = JSON.parse(await readFile(path.join(cwd, ".reins/manifest.json"), "utf8"));
    expect(manifest.runtime).toBe("opencode");

    // Runtime-neutral docs render the opencode wiring, not Claude hooks.
    const verification = await readFile(path.join(cwd, "docs/verification.md"), "utf8");
    expect(verification).toContain("reins-verify.ts");
    expect(verification).not.toContain("Claude Code hooks");

    // Idempotent: a second run touches nothing.
    const second = await runInit({
      cwd,
      preset: "sdd",
      runtime: "opencode",
      harnessVersion: "9.9.9",
      installGitHook: false,
    });
    expect(second.outcomes.every((o) => o.action === "skip")).toBe(true);
  });
});

describe("reins init — opencode runtime (lite)", () => {
  it("omits sdd-only files and the Claude tree", async () => {
    const cwd = await nodeProject();
    await runInit({
      cwd,
      preset: "lite",
      runtime: "opencode",
      harnessVersion: "9.9.9",
      installGitHook: false,
    });
    expect(await exists(path.join(cwd, ".opencode/agents/spec_author.md"))).toBe(false);
    expect(await exists(path.join(cwd, "specs/_template/requirements.md"))).toBe(false);
    expect(await exists(path.join(cwd, ".opencode/commands/brainstorm.md"))).toBe(true);
    expect(await exists(path.join(cwd, ".claude"))).toBe(false);
    expect(await exists(path.join(cwd, "CLAUDE.md"))).toBe(false);
  });
});
