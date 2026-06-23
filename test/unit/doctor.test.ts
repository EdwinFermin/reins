import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctorFix } from "../../src/core/doctor/fix";
import { computeDoctorExit, runDoctor } from "../../src/core/doctor/runner";
import { runInit } from "../../src/core/init/run";

async function initedProject(version = "0.1.0"): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-doctor-"));
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --version" } }),
  );
  await runInit({ cwd, preset: "sdd", harnessVersion: version, installGitHook: false });
  return cwd;
}

describe("runDoctor", () => {
  it("reports a freshly installed harness as healthy", async () => {
    const cwd = await initedProject();
    const report = await runDoctor(cwd, "0.1.0");
    expect(report.installed).toBe(true);
    expect(report.ok).toBe(true);
    expect(computeDoctorExit(report)).toBe(0);
  });

  it("flags a missing agent as a failure", async () => {
    const cwd = await initedProject();
    await rm(path.join(cwd, ".claude/agents/leader.md"));
    const report = await runDoctor(cwd, "0.1.0");
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.id === "agent:leader")?.status).toBe("fail");
    expect(computeDoctorExit(report)).toBe(1);
  });

  it("reports a non-harness directory as not installed (exit 2)", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-doctor-empty-"));
    const report = await runDoctor(cwd, "0.1.0");
    expect(report.installed).toBe(false);
    expect(computeDoctorExit(report)).toBe(2);
  });

  it("warns on invalid model/effort frontmatter values", async () => {
    const cwd = await initedProject();
    const reviewer = path.join(cwd, ".claude/agents/reviewer.md");
    const text = await readFile(reviewer, "utf8");
    await writeFile(reviewer, text.replace("model: sonnet", "model: sonnet\neffort: ultra"));

    const report = await runDoctor(cwd, "0.1.0");
    const entry = report.results.find((r) => r.id === "agent:reviewer");
    expect(entry?.status).toBe("warn");
    expect(entry?.summary).toContain('invalid effort "ultra"');
    expect(report.ok).toBe(true); // warn, not fail
  });

  it("warns when the harness version is behind the CLI", async () => {
    const cwd = await initedProject("0.1.0");
    const report = await runDoctor(cwd, "0.2.0");
    expect(report.ok).toBe(true);
    expect(report.updateAvailable).toBe(true);
    expect(report.results.find((r) => r.id === "version")?.status).toBe("warn");
  });

  it("reports a healthy ghost install and flags exclude drift", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-doctor-ghost-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node --version" } }),
    );
    await mkdir(path.join(cwd, ".git", "info"), { recursive: true });
    await runInit({
      cwd,
      preset: "lite",
      harnessVersion: "0.1.0",
      installGitHook: false,
      gitExclude: true,
    });

    const healthy = await runDoctor(cwd, "0.1.0");
    expect(healthy.ok).toBe(true);
    expect(healthy.results.find((r) => r.id === "ghost")?.status).toBe("ok");

    // Wipe the exclude file -> doctor warns the harness is no longer ignored.
    await writeFile(path.join(cwd, ".git/info/exclude"), "");
    const drifted = await runDoctor(cwd, "0.1.0");
    expect(drifted.results.find((r) => r.id === "ghost")?.status).toBe("warn");
    expect(drifted.ok).toBe(true); // warn, not fail
  });

  it("checks the opencode plugin/config and tolerates the missing Claude tree", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-doctor-oc-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node --version" } }),
    );
    await runInit({
      cwd,
      preset: "sdd",
      runtime: "opencode",
      harnessVersion: "0.1.0",
      installGitHook: false,
    });

    const healthy = await runDoctor(cwd, "0.1.0");
    expect(healthy.ok).toBe(true);
    expect(healthy.results.find((r) => r.id === "gate")?.status).toBe("ok");
    expect(healthy.results.find((r) => r.id === "opencode-config")?.status).toBe("ok");

    // Removing the verify plugin fails the gate check.
    await rm(path.join(cwd, ".opencode/plugins/reins-verify.ts"));
    const broken = await runDoctor(cwd, "0.1.0");
    expect(broken.ok).toBe(false);
    expect(broken.results.find((r) => r.id === "gate")?.status).toBe("fail");
  });
});

describe("runDoctorFix", () => {
  it("recreates missing files without touching existing ones", async () => {
    const cwd = await initedProject();
    await rm(path.join(cwd, ".claude/agents/leader.md"));
    await rm(path.join(cwd, "docs/security.md"));

    const created = await runDoctorFix(cwd);
    expect(created).toContain(".claude/agents/leader.md");
    expect(created).toContain("docs/security.md");

    await expect(stat(path.join(cwd, ".claude/agents/leader.md"))).resolves.toBeDefined();
    const report = await runDoctor(cwd, "0.1.0");
    expect(report.ok).toBe(true);
  });
});
