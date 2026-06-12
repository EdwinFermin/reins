import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../../src/core/init/run";
import { classifyThreeWay, runUpdate } from "../../src/core/update/run";

async function inited(version = "0.1.0"): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-update-"));
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --version" } }),
  );
  await runInit({ cwd, preset: "sdd", harnessVersion: version, installGitHook: false });
  return cwd;
}

describe("classifyThreeWay", () => {
  it("covers every branch", () => {
    expect(classifyThreeWay(null, "A", "B")).toBe("added");
    expect(classifyThreeWay("B", "A", "B")).toBe("skip");
    expect(classifyThreeWay("A", "A", "B")).toBe("updated"); // disk == base, template changed
    expect(classifyThreeWay("U", "A", "A")).toBe("kept-user"); // user changed, template same
    expect(classifyThreeWay("U", "A", "B")).toBe("conflict"); // both changed
  });
});

describe("runUpdate", () => {
  it("keeps user-modified files when the template is unchanged", async () => {
    const cwd = await inited("0.1.0");
    const reviewer = path.join(cwd, ".claude/agents/reviewer.md");
    await appendFile(reviewer, "\n<!-- my custom note -->\n");

    const result = await runUpdate({ cwd, harnessVersion: "0.1.0", apply: true });
    const entry = result.entries.find((e) => e.path === ".claude/agents/reviewer.md");
    expect(entry?.action).toBe("kept-user");
    expect(await readFile(reviewer, "utf8")).toContain("my custom note");
  });

  it("recreates a deleted file (added)", async () => {
    const cwd = await inited("0.1.0");
    await rm(path.join(cwd, ".claude/agents/leader.md"));
    const result = await runUpdate({ cwd, harnessVersion: "0.1.0", apply: true });
    expect(result.entries.find((e) => e.path === ".claude/agents/leader.md")?.action).toBe("added");
    await expect(stat(path.join(cwd, ".claude/agents/leader.md"))).resolves.toBeDefined();
  });

  it("bumps the harness version on apply, and writes nothing on a dry run", async () => {
    const cwd = await inited("0.1.0");

    const dry = await runUpdate({ cwd, harnessVersion: "0.2.0", apply: false });
    expect(dry.applied).toBe(false);
    expect(
      JSON.parse(await readFile(path.join(cwd, "reins.config.json"), "utf8")).harnessVersion,
    ).toBe("0.1.0");

    const applied = await runUpdate({ cwd, harnessVersion: "0.2.0", apply: true });
    expect(applied.applied).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(cwd, "reins.config.json"), "utf8")).harnessVersion,
    ).toBe("0.2.0");
    expect(
      JSON.parse(await readFile(path.join(cwd, ".reins/manifest.json"), "utf8")).harnessVersion,
    ).toBe("0.2.0");
  });

  it("reports not installed for a bare directory", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-update-bare-"));
    const result = await runUpdate({ cwd, harnessVersion: "0.2.0", apply: true });
    expect(result.installed).toBe(false);
  });

  it("renders identical agent files for legacy configs without an agents section", async () => {
    const cwd = await inited("0.1.0");

    // Simulate a legacy harness: no `agents` section (Zod fills all-inherit) and
    // rebase the manifest onto that state.
    const cfgPath = path.join(cwd, "reins.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    delete cfg.agents;
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    await runUpdate({ cwd, harnessVersion: "0.1.0", apply: true });

    const reviewer = path.join(cwd, ".claude/agents/reviewer.md");
    const text = await readFile(reviewer, "utf8");
    expect(text).not.toContain("model:"); // inherit -> field omitted entirely
    expect(text).toContain("tools: Read, Glob, Grep, Bash\n---");

    // A user edit on top of the inherit render must survive as kept-user, never conflict.
    await appendFile(reviewer, "\n<!-- my custom note -->\n");
    const result = await runUpdate({ cwd, harnessVersion: "0.1.0", apply: true });
    expect(result.entries.some((e) => e.action === "conflict")).toBe(false);
    expect(result.entries.find((e) => e.path === ".claude/agents/reviewer.md")?.action).toBe(
      "kept-user",
    );
  });

  it("rewrites agent frontmatter when the config changes a role's model", async () => {
    const cwd = await inited("0.1.0");

    const cfgPath = path.join(cwd, "reins.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.agents = { ...cfg.agents, implementer: { model: "haiku", effort: "low" } };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

    const result = await runUpdate({ cwd, harnessVersion: "0.1.0", apply: true });
    expect(result.entries.find((e) => e.path === ".claude/agents/implementer.md")?.action).toBe(
      "updated",
    );
    const text = await readFile(path.join(cwd, ".claude/agents/implementer.md"), "utf8");
    expect(text).toContain("model: haiku\neffort: low\n---");
  });
});
