import { execa } from "execa";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ReinsConfigSchema, type ReinsConfig } from "../../src/core/config/schema";
import { deepMergeSettings } from "../../src/core/fs/merge";
import {
  computeExitCode,
  resolveProfile,
  runVerify,
  shouldGateSubagent,
} from "../../src/core/verify/runner";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function makeConfig(overrides: Record<string, unknown> = {}): ReinsConfig {
  return ReinsConfigSchema.parse({
    harnessVersion: "0.0.0",
    preset: "lite",
    stack: { language: "node" },
    commands: {},
    security: { depsAudit: { enabled: false }, secretScan: { enabled: false } },
    ...overrides,
  });
}

const tmp = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "reins-milestone-"));

describe("per-hook profiles", () => {
  it("runs nothing for an empty profile and `required` for an unlisted hook", () => {
    const config = makeConfig({ verify: { perHook: { PostToolUse: [] } } });
    expect(resolveProfile({ cwd: ".", config, hook: "PostToolUse" })).toEqual([]);
    expect(resolveProfile({ cwd: ".", config, hook: "SubagentStop" })).toEqual(
      config.verify.required,
    );
  });

  it("includes typecheck in the default gate", () => {
    expect(makeConfig().verify.required).toContain("typecheck");
  });
});

describe("shouldGateSubagent", () => {
  const config = makeConfig();
  it.each([
    ["implementer", true],
    ["my-plugin:implementer", true],
    ["reviewer", false],
    ["Explore", false],
    [null, false],
  ])("%s → %s", (type, gated) => {
    expect(shouldGateSubagent(config, type)).toBe(gated);
  });

  it("follows verify.gateAgents", () => {
    const custom = makeConfig({ verify: { gateAgents: ["implementer", "migrator"] } });
    expect(shouldGateSubagent(custom, "migrator")).toBe(true);
  });
});

describe("typecheck check", () => {
  it("runs the configured command, and is cached like lint/tests", async () => {
    const cwd = await tmp();
    await writeFile(path.join(cwd, "a.ts"), "export const a = 1;\n");
    const ok = makeConfig({ commands: { typecheck: 'node -e "process.exit(0)"' } });
    expect((await runVerify({ cwd, config: ok, only: ["typecheck"] })).results[0]!.status).toBe(
      "pass",
    );
    const again = await runVerify({ cwd, config: ok, only: ["typecheck"] });
    expect(again.results[0]!.summary).toContain("cached");

    const bad = makeConfig({ commands: { typecheck: 'node -e "process.exit(2)"' } });
    expect((await runVerify({ cwd, config: bad, only: ["typecheck"] })).ok).toBe(false);
  });
});

describe("SubagentStop repeat guard", () => {
  it("releases an identical block repeated with no file changes, with its own counter", async () => {
    const cwd = await tmp();
    await writeFile(path.join(cwd, "a.ts"), "export const a = 1;\n");
    const config = makeConfig({
      commands: { test: 'node -e "process.exit(1)"' },
      verify: { required: ["unit"], stop: { maxRepeatBlocks: 2 } },
    });
    const run = () =>
      runVerify({ cwd, config, hook: "SubagentStop", sessionId: "s1", noCache: true });
    expect(computeExitCode(await run(), "SubagentStop")).toBe(2);
    expect(computeExitCode(await run(), "SubagentStop")).toBe(2);
    const third = await run();
    expect(third.gaveUp).toBe(true);
    expect(computeExitCode(third, "SubagentStop")).toBe(0);
    // Stop keeps its own counter: it still blocks.
    const stop = await runVerify({ cwd, config, hook: "Stop", sessionId: "s1", noCache: true });
    expect(computeExitCode(stop, "Stop")).toBe(2);
  });
});

describe("settings merge", () => {
  it("removes the retired per-edit hook but keeps a user-edited one", () => {
    const merged = deepMergeSettings(
      {
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit|Write|MultiEdit",
              hooks: [
                { type: "command", command: "npx reins verify --hook PostToolUse --changed" },
              ],
            },
            { matcher: "Write", hooks: [{ type: "command", command: "npx prettier --write" }] },
          ],
          Notification: [
            {
              hooks: [
                { type: "command", command: "npx reins verify --hook PostToolUse --changed" },
              ],
            },
          ],
        },
      },
      {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "npx reins verify --hook Stop" }] }],
        },
      },
    );
    expect(merged.hooks.PostToolUse).toEqual([
      { matcher: "Write", hooks: [{ type: "command", command: "npx prettier --write" }] },
    ]);
    expect(merged.hooks.Notification).toBeUndefined();
    expect(merged.hooks.Stop).toHaveLength(1);
  });
});

describe("reins verify --hook SubagentStop (CLI)", () => {
  async function harness(): Promise<string> {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "reins.config.json"),
      JSON.stringify({
        harnessVersion: "0.0.0",
        preset: "lite",
        stack: { language: "node" },
        commands: { test: 'node -e "process.exit(1)"' },
        verify: { required: ["unit"], cache: false },
        security: { depsAudit: { enabled: false }, secretScan: { enabled: false } },
      }),
    );
    return cwd;
  }
  const verify = (cwd: string, payload: unknown) =>
    execa(
      "npx",
      ["tsx", path.join(root, "src/cli.ts"), "verify", "--hook", "SubagentStop", "--cwd", cwd],
      {
        input: JSON.stringify(payload),
        reject: false,
      },
    );

  it("blocks the implementer on a red tree and lets other subagents finish", async () => {
    const cwd = await harness();
    const implementer = await verify(cwd, { session_id: "s", agent_type: "implementer" });
    expect(implementer.exitCode).toBe(2);
    expect(implementer.stderr).toContain("Reins blocked the SubagentStop hook");

    const reviewer = await verify(cwd, { session_id: "s", agent_type: "reviewer" });
    expect(reviewer.exitCode).toBe(0);
    expect(reviewer.stdout).toBe("");
  }, 30_000);
});
