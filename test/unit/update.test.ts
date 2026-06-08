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
});
