import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReinsConfigSchema, type ReinsConfig } from "../../src/core/config/schema";
import {
  computeExitCode,
  parseCheckIds,
  resolveProfile,
  runVerify,
} from "../../src/core/verify/runner";

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "reins-verify-"));
}

function makeConfig(overrides: Record<string, unknown>): ReinsConfig {
  return ReinsConfigSchema.parse({
    harnessVersion: "0.0.0",
    preset: "lite",
    stack: { language: "node" },
    commands: {},
    security: { depsAudit: { enabled: false }, secretScan: { enabled: true } },
    ...overrides,
  });
}

describe("runVerify — command checks", () => {
  it("passes when the test command exits 0", async () => {
    const cwd = await tmp();
    const config = makeConfig({ commands: { test: 'node -e "process.exit(0)"' } });
    const report = await runVerify({ cwd, config, only: ["unit"] });
    expect(report.ok).toBe(true);
    expect(report.results[0]?.status).toBe("pass");
    expect(computeExitCode(report)).toBe(0);
  });

  it("fails on exit 1, and blocks (exit 2) only for blocking hooks", async () => {
    const cwd = await tmp();
    const config = makeConfig({ commands: { test: 'node -e "process.exit(1)"' } });
    const report = await runVerify({ cwd, config, only: ["unit"] });
    expect(report.ok).toBe(false);
    expect(computeExitCode(report)).toBe(1);
    expect(computeExitCode(report, "Stop")).toBe(2);
    expect(computeExitCode(report, "PostToolUse")).toBe(2);
    expect(computeExitCode(report, "CI")).toBe(1);
  });
});

describe("runVerify — feature-list", () => {
  it("fails when more than one feature is in_progress", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "feature_list.json"),
      JSON.stringify({
        version: 1,
        features: [
          { slug: "a", state: "in_progress" },
          { slug: "b", state: "in_progress" },
        ],
      }),
    );
    const config = makeConfig({});
    const report = await runVerify({ cwd, config, only: ["feature-list"] });
    expect(report.results[0]?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("passes for a fresh, empty feature list", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "feature_list.json"),
      JSON.stringify({ version: 1, features: [] }),
    );
    const config = makeConfig({});
    const report = await runVerify({ cwd, config, only: ["feature-list"] });
    expect(report.results[0]?.status).toBe("pass");
  });
});

describe("runVerify — security secret scan", () => {
  it("fails when a recognizable secret is present", async () => {
    const cwd = await tmp();
    await writeFile(path.join(cwd, "leak.txt"), "aws_key=AKIAIOSFODNN7EXAMPLE\n");
    const config = makeConfig({});
    const report = await runVerify({ cwd, config, only: ["security"] });
    expect(report.results[0]?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("passes on a clean tree", async () => {
    const cwd = await tmp();
    await writeFile(path.join(cwd, "hello.txt"), "just some plain text here\n");
    const config = makeConfig({});
    const report = await runVerify({ cwd, config, only: ["security"] });
    expect(report.results[0]?.status).toBe("pass");
  });
});

describe("resolveProfile + parseCheckIds", () => {
  it("prefers --only, then per-hook, then required", () => {
    const config = makeConfig({
      verify: { required: ["unit"], perHook: { Stop: ["lint", "security"] } },
    });
    expect(resolveProfile({ cwd: ".", config, only: ["e2e"] })).toEqual(["e2e"]);
    expect(resolveProfile({ cwd: ".", config, hook: "Stop" })).toEqual(["lint", "security"]);
    expect(resolveProfile({ cwd: ".", config })).toEqual(["unit"]);
  });

  it("separates valid from invalid check ids", () => {
    const { ids, invalid } = parseCheckIds("lint, unit, bogus");
    expect(ids).toEqual(["lint", "unit"]);
    expect(invalid).toEqual(["bogus"]);
  });
});
