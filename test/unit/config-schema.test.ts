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

  it("omits traceability for the lite preset", () => {
    const cfg = buildDefaultConfig({
      profile: { language: "other", frameworks: [], commands: {} },
      preset: "lite",
      harnessVersion: "0.1.0",
    });
    expect(cfg.verify.required).not.toContain("traceability");
  });
});
