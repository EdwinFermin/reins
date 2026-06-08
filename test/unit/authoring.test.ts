import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addAgent } from "../../src/core/agents/add-agent";
import { addFeature } from "../../src/core/features/add-feature";
import { runInit } from "../../src/core/init/run";
import { getStatus } from "../../src/core/status/run";

async function inited(preset: "lite" | "sdd" = "sdd"): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-authoring-"));
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --version" } }),
  );
  await runInit({ cwd, preset, harnessVersion: "0.1.0", installGitHook: false });
  return cwd;
}

describe("addFeature", () => {
  it("registers a pending feature and scaffolds its spec", async () => {
    const cwd = await inited("sdd");
    const result = await addFeature({ cwd, slug: "auth-login", title: "Login", withSpec: true });
    expect(result.added).toBe(true);
    expect(result.specCreated).toBe(true);

    const fl = JSON.parse(await readFile(path.join(cwd, "feature_list.json"), "utf8"));
    expect(
      fl.features.some(
        (f: { slug: string; state: string }) => f.slug === "auth-login" && f.state === "pending",
      ),
    ).toBe(true);

    const requirements = await readFile(path.join(cwd, "specs/auth-login/requirements.md"), "utf8");
    expect(requirements).toContain("auth-login");
  });

  it("rejects duplicate slugs and invalid slugs", async () => {
    const cwd = await inited("sdd");
    await addFeature({ cwd, slug: "auth-login" });
    expect((await addFeature({ cwd, slug: "auth-login" })).added).toBe(false);
    expect((await addFeature({ cwd, slug: "Bad Slug" })).added).toBe(false);
  });
});

describe("addAgent", () => {
  it("adds a custom agent from a base role with a tools override", async () => {
    const cwd = await inited("lite");
    const result = await addAgent({
      cwd,
      role: "perf-reviewer",
      from: "reviewer",
      tools: "Read, Grep",
    });
    expect(result.added).toBe(true);

    const text = await readFile(path.join(cwd, ".claude/agents/perf-reviewer.md"), "utf8");
    expect(text).toContain("name: perf-reviewer");
    expect(text).toContain("tools: Read, Grep");
  });

  it("refuses an existing agent and unknown roles", async () => {
    const cwd = await inited("lite");
    expect((await addAgent({ cwd, role: "reviewer" })).added).toBe(false); // created by init
    expect((await addAgent({ cwd, role: "nope" })).added).toBe(false);
  });
});

describe("getStatus", () => {
  it("summarizes features and the active one", async () => {
    const cwd = await inited("sdd");
    await addFeature({ cwd, slug: "a" });
    await addFeature({ cwd, slug: "b" });

    const flPath = path.join(cwd, "feature_list.json");
    const fl = JSON.parse(await readFile(flPath, "utf8"));
    fl.features[0].state = "in_progress";
    await writeFile(flPath, JSON.stringify(fl, null, 2));

    const status = await getStatus(cwd);
    expect(status.installed).toBe(true);
    expect(status.total).toBe(2);
    expect(status.active?.slug).toBe("a");
    expect(status.counts.in_progress).toBe(1);
    expect(status.pending).toContain("b");
  });

  it("reports not installed for a bare directory", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-authoring-bare-"));
    expect((await getStatus(cwd)).installed).toBe(false);
  });
});
