import { describe, expect, it } from "vitest";
import { buildDefaultConfig } from "../../src/core/config/defaults";
import { ReinsConfigSchema } from "../../src/core/config/schema";

describe("ReinsConfig schema", () => {
  it("accepts a minimal config and fills defaults", () => {
    const parsed = ReinsConfigSchema.parse({
      harnessVersion: "0.1.0",
      preset: "lite",
      stack: { language: "node" },
      commands: {},
    });
    expect(parsed.runtime).toBe("claude");
    expect(parsed.security.depsAudit.failOn).toBe("high");
    expect(parsed.security.secretScan.failOnAny).toBe(true);
    expect(parsed.telemetry.enabled).toBe(true);
    expect(parsed.commands.test).toBeNull();
  });

  it("defaults every agent policy to inherit", () => {
    const parsed = ReinsConfigSchema.parse({
      harnessVersion: "0.1.0",
      preset: "lite",
      stack: { language: "node" },
      commands: {},
    });
    expect(parsed.agents.leader.model).toBe("inherit");
    expect(parsed.agents.reviewer.model).toBe("inherit");
    expect(parsed.agents.reviewer.effort).toBeUndefined();
  });

  it("accepts aliases, full model IDs, and effort levels per agent", () => {
    const parsed = ReinsConfigSchema.parse({
      harnessVersion: "0.1.0",
      preset: "lite",
      stack: { language: "node" },
      commands: {},
      agents: {
        reviewer: { model: "haiku", effort: "low" },
        implementer: { model: "claude-sonnet-4-6" },
      },
    });
    expect(parsed.agents.reviewer.model).toBe("haiku");
    expect(parsed.agents.reviewer.effort).toBe("low");
    expect(parsed.agents.implementer.model).toBe("claude-sonnet-4-6");
  });

  it("rejects invalid effort levels and unknown agent roles", () => {
    const base = {
      harnessVersion: "0.1.0",
      preset: "lite",
      stack: { language: "node" },
      commands: {},
    };
    expect(
      ReinsConfigSchema.safeParse({ ...base, agents: { reviewer: { effort: "ultra" } } }).success,
    ).toBe(false);
    expect(ReinsConfigSchema.safeParse({ ...base, agents: { bogus: {} } }).success).toBe(false);
  });

  it("rejects bad presets and unknown top-level keys", () => {
    expect(
      ReinsConfigSchema.safeParse({
        harnessVersion: "1",
        preset: "nope",
        stack: { language: "node" },
        commands: {},
      }).success,
    ).toBe(false);

    expect(
      ReinsConfigSchema.safeParse({
        harnessVersion: "1",
        preset: "lite",
        stack: { language: "node" },
        commands: {},
        bogus: true,
      }).success,
    ).toBe(false);
  });
});

describe("buildDefaultConfig", () => {
  it("maps detected commands and adds traceability for sdd", () => {
    const cfg = buildDefaultConfig({
      profile: {
        language: "node",
        packageManager: "pnpm",
        frameworks: ["next"],
        commands: {
          test: { value: "pnpm test", confidence: "high", source: "scripts.test" },
        },
      },
      preset: "sdd",
      harnessVersion: "0.1.0",
    });
    expect(cfg.preset).toBe("sdd");
    expect(cfg.verify.required).toContain("traceability");
    expect(cfg.commands.test).toBe("pnpm test");
    expect(cfg.commands.build).toBeNull();
    expect(cfg.stack.frameworks).toEqual(["next"]);
  });

  it("writes cost-aware agent defaults for new installs", () => {
    const cfg = buildDefaultConfig({
      profile: { language: "node", frameworks: [], commands: {} },
      preset: "sdd",
      harnessVersion: "0.1.0",
    });
    expect(cfg.agents.leader.model).toBe("inherit");
    expect(cfg.agents.implementer.model).toBe("inherit");
    expect(cfg.agents["security-reviewer"].model).toBe("inherit");
    expect(cfg.agents.reviewer.model).toBe("sonnet");
    expect(cfg.agents.spec_author.model).toBe("sonnet");
    expect(cfg.agents.reviewer.effort).toBeUndefined();
  });

  it("omits traceability for the lite preset", () => {
    const cfg = buildDefaultConfig({
      profile: { language: "other", frameworks: [], commands: {} },
      preset: "lite",
      harnessVersion: "0.1.0",
    });
    expect(cfg.verify.required).not.toContain("traceability");
  });
});
