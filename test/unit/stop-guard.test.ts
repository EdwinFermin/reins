import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReinsConfigSchema, type ReinsConfig } from "../../src/core/config/schema";
import { migrateConfig } from "../../src/core/update/run";
import { formatReport } from "../../src/core/verify/report";
import { computeExitCode, runVerify } from "../../src/core/verify/runner";
import { recordSessionStart } from "../../src/core/verify/stop-guard";

const BRACES = "GHSA-vfj7-8cjw-p6xm";
const LODASH = "GHSA-aaaa-bbbb-cccc";
const NOW = new Date(2026, 9, 5);

function vuln(name: string, ghsa: string) {
  return {
    name,
    severity: "high",
    via: [
      {
        source: 1,
        name,
        title: "t",
        url: `https://github.com/advisories/${ghsa}`,
        severity: "high",
      },
    ],
  };
}

function auditOutput(ghsas: string[]): string {
  const vulnerabilities: Record<string, unknown> = {};
  ghsas.forEach((g, i) => (vulnerabilities[`pkg${i}`] = vuln(`pkg${i}`, g)));
  return JSON.stringify({ vulnerabilities, metadata: { vulnerabilities: { high: ghsas.length } } });
}

let binDir: string;
const originalPath = process.env.PATH;

beforeAll(async () => {
  // A fake `npm` that prints whatever audit.json sits in the current directory.
  binDir = await mkdtemp(path.join(os.tmpdir(), "reins-fake-npm-"));
  const npm = path.join(binDir, "npm");
  await writeFile(npm, '#!/bin/sh\ncat "$PWD/audit.json"\n');
  await chmod(npm, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
});

async function project(findings: string[]): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-stop-"));
  await writeFile(path.join(cwd, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(path.join(cwd, "audit.json"), auditOutput(findings));
  return cwd;
}

function config(
  overrides: { stop?: Record<string, unknown>; ignore?: unknown[] } = {},
): ReinsConfig {
  return ReinsConfigSchema.parse({
    harnessVersion: "0.0.0",
    preset: "lite",
    stack: { language: "node", packageManager: "npm" },
    commands: { test: 'node -e "process.exit(1)"' },
    verify: { required: ["security", "unit"], stop: overrides.stop ?? {} },
    security: {
      depsAudit: { enabled: true, ignore: overrides.ignore ?? [] },
      secretScan: { enabled: false },
    },
  });
}

const stop = (cwd: string, cfg: ReinsConfig, sessionId: string | null = "s1") =>
  runVerify({ cwd, config: cfg, hook: "Stop", only: ["security"], sessionId, now: NOW });

describe("security summary with an allowlist", () => {
  it("reports ignored findings and the earliest expiry", async () => {
    const cwd = await project([BRACES, BRACES, LODASH]);
    const cfg = config({
      ignore: [
        { id: BRACES, reason: "no fix", until: "2026-11-05" },
        { id: LODASH, reason: "dev only", until: "2027-01-01" },
      ],
    });
    const report = await runVerify({ cwd, config: cfg, only: ["security"], now: NOW });
    expect(report.ok).toBe(true);
    expect(report.results[0]!.summary).toContain(
      "no vulnerabilities >= high (3 ignored via 2 allowlisted advisories, earliest expiry 2026-11-05)",
    );
  });

  it("fails with a clear message once an entry has expired", async () => {
    const cwd = await project([BRACES]);
    const cfg = config({ ignore: [{ id: BRACES, reason: "no fix", until: "2026-10-01" }] });
    const report = await runVerify({ cwd, config: cfg, only: ["security"], now: NOW });
    expect(report.ok).toBe(false);
    expect(report.results[0]!.summary).toContain(
      `ignore for ${BRACES} expired on 2026-10-01, re-evaluate`,
    );
  });
});

describe("Stop baseline", () => {
  it("passes with a warning when findings pre-date the session and the lockfile is unchanged", async () => {
    const cwd = await project([BRACES]);
    const cfg = config();
    await recordSessionStart(cwd, "s1", NOW);

    const report = await stop(cwd, cfg);
    expect(report.ok).toBe(true);
    expect(report.results[0]!.status).toBe("warn");
    expect(report.notices.join(" ")).toContain("already present when this session started");
    expect(report.notices.join(" ")).toContain(BRACES);
    expect(computeExitCode(report, "Stop")).toBe(0);
    expect(formatReport(report, { hook: "Stop" })).toContain("PASS (with warnings)");
  });

  it("falls back to the first verify of the session when SessionStart didn't record one", async () => {
    const cwd = await project([BRACES]);
    const report = await stop(cwd, config());
    expect(report.ok).toBe(true);
    expect(report.results[0]!.status).toBe("warn");
  });

  it("blocks when the session introduced a new advisory", async () => {
    const cwd = await project([BRACES]);
    const cfg = config();
    await recordSessionStart(cwd, "s1", NOW);
    expect((await stop(cwd, cfg)).ok).toBe(true); // baseline = braces

    await writeFile(path.join(cwd, "audit.json"), auditOutput([BRACES, LODASH]));
    const report = await stop(cwd, cfg);
    expect(report.ok).toBe(false);
    expect(computeExitCode(report, "Stop")).toBe(2);
    expect(report.notices.join(" ")).toContain(
      `new dependency advisories since the session started: ${LODASH}`,
    );
  });

  it("blocks when the session changed the lockfile and findings remain", async () => {
    const cwd = await project([BRACES]);
    const cfg = config();
    await recordSessionStart(cwd, "s1", NOW);
    expect((await stop(cwd, cfg)).ok).toBe(true);

    await writeFile(path.join(cwd, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
    const report = await stop(cwd, cfg);
    expect(report.ok).toBe(false);
    expect(report.notices.join(" ")).toContain("lockfile changed this session");
  });

  it("never baselines findings when the lockfile changed before the first audit", async () => {
    const cwd = await project([]);
    await recordSessionStart(cwd, "s1", NOW);
    // The agent adds a vulnerable dependency, then tries to stop.
    await writeFile(path.join(cwd, "package-lock.json"), '{"lockfileVersion":3,"added":true}\n');
    await writeFile(path.join(cwd, "audit.json"), auditOutput([LODASH]));
    const report = await stop(cwd, config());
    expect(report.ok).toBe(false);
  });

  it("a new session id starts a fresh baseline; a resumed one keeps it", async () => {
    const cwd = await project([BRACES]);
    const cfg = config();
    await recordSessionStart(cwd, "s1", NOW);
    expect((await stop(cwd, cfg)).ok).toBe(true);

    // Resume (same id) keeps the baseline even though SessionStart fires again.
    await recordSessionStart(cwd, "s1", NOW);
    const state = JSON.parse(
      await readFile(path.join(cwd, ".reins/cache/verify-session.json"), "utf8"),
    );
    expect(state.baseline.advisories).toEqual([BRACES]);

    await recordSessionStart(cwd, "s2", NOW);
    const fresh = JSON.parse(
      await readFile(path.join(cwd, ".reins/cache/verify-session.json"), "utf8"),
    );
    expect(fresh.sessionId).toBe("s2");
    expect(fresh.baseline).toBeNull();
  });

  it("can be disabled", async () => {
    const cwd = await project([BRACES]);
    const cfg = config({ stop: { baselinePreexisting: false } });
    await recordSessionStart(cwd, "s1", NOW);
    const report = await stop(cwd, cfg);
    expect(report.ok).toBe(false);
    expect(report.results[0]!.status).toBe("fail");
  });

  it("does not apply outside the Stop hook", async () => {
    const cwd = await project([BRACES]);
    await recordSessionStart(cwd, "s1", NOW);
    const report = await runVerify({ cwd, config: config(), only: ["security"], now: NOW });
    expect(report.ok).toBe(false);
  });
});

describe("Stop repeat-block guard", () => {
  const unitStop = (cwd: string, cfg: ReinsConfig) =>
    runVerify({ cwd, config: cfg, hook: "Stop", only: ["unit"], sessionId: "s1", now: NOW });

  async function emptyProject(): Promise<string> {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-repeat-"));
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
    return cwd;
  }

  it("gives up after N identical blocks with no file changes", async () => {
    const cwd = await emptyProject();
    const cfg = config({ stop: { maxRepeatBlocks: 3 } });

    for (let i = 0; i < 3; i++) {
      const r = await unitStop(cwd, cfg);
      expect(computeExitCode(r, "Stop")).toBe(2);
      expect(r.gaveUp).toBe(false);
    }
    const released = await unitStop(cwd, cfg);
    expect(released.ok).toBe(false);
    expect(released.gaveUp).toBe(true);
    expect(computeExitCode(released, "Stop")).toBe(0);
    expect(released.notices.join(" ")).toContain("repeated identical Stop block");
    expect(formatReport(released, { hook: "Stop" })).toContain("not blocking");
  });

  it("resets the count when files change between attempts", async () => {
    const cwd = await emptyProject();
    const cfg = config({ stop: { maxRepeatBlocks: 2 } });
    await unitStop(cwd, cfg);
    await unitStop(cwd, cfg);
    await writeFile(path.join(cwd, "src", "a.ts"), "export const a = 2; // attempted fix\n");
    const r = await unitStop(cwd, cfg);
    expect(r.gaveUp).toBe(false);
    expect(computeExitCode(r, "Stop")).toBe(2);
  });

  it("never gives up when maxRepeatBlocks is 0", async () => {
    const cwd = await emptyProject();
    const cfg = config({ stop: { maxRepeatBlocks: 0 } });
    for (let i = 0; i < 5; i++) expect(computeExitCode(await unitStop(cwd, cfg), "Stop")).toBe(2);
  });

  it("only releases the Stop hook, never CI", async () => {
    const cwd = await emptyProject();
    const cfg = config({ stop: { maxRepeatBlocks: 1 } });
    await unitStop(cwd, cfg);
    const released = await unitStop(cwd, cfg);
    expect(released.gaveUp).toBe(true);
    expect(computeExitCode(released, "CI")).toBe(1);
  });
});

describe("reins update — config migration", () => {
  it("adds new keys with defaults without touching existing values", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-migrate-"));
    const file = path.join(cwd, "reins.config.json");
    await writeFile(
      file,
      JSON.stringify({
        harnessVersion: "0.9.0",
        verify: { required: ["unit"] },
        security: { depsAudit: { failOn: "critical" } },
      }),
    );

    expect(await migrateConfig(cwd, "0.12.0", false)).toEqual([
      "verify.stop",
      "security.depsAudit.ignore",
      "commands.lintChanged",
      "commands.testChanged",
      "verify.cache",
      "verify.gateAgents",
      "router",
    ]);
    expect(JSON.parse(await readFile(file, "utf8")).harnessVersion).toBe("0.9.0"); // dry run

    await migrateConfig(cwd, "0.12.0", true);
    const cfg = JSON.parse(await readFile(file, "utf8"));
    expect(cfg.verify).toEqual({
      required: ["unit"], // no typecheck command configured → untouched
      stop: { baselinePreexisting: true, maxRepeatBlocks: 3 },
      cache: true,
      perHook: {},
      gateAgents: ["implementer"],
    });
    expect(cfg.security.depsAudit).toEqual({ failOn: "critical", ignore: [] });
    // No lint/test command configured → no scoped variant either.
    expect(cfg.commands).toEqual({ lintChanged: null, testChanged: null });
    expect(cfg.router).toEqual({ provider: "auto" });
    expect(await migrateConfig(cwd, "0.12.0", true)).toEqual([]);
  });

  it("turns off the old per-edit defaults, adds typecheck, and detects scoped commands", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-migrate-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        scripts: { test: "jest", lint: "expo lint" },
        devDependencies: { eslint: "^9.0.0", "jest-expo": "^52.0.0" },
      }),
    );
    const file = path.join(cwd, "reins.config.json");
    const base = {
      harnessVersion: "0.10.0",
      commands: { test: "npm test", lint: "npm run lint", typecheck: "npx tsc --noEmit" },
    };
    // keel's real shape: explicit Stop/CI profiles, no typecheck anywhere.
    await writeFile(
      file,
      JSON.stringify({
        ...base,
        verify: {
          required: ["lint", "unit", "security"],
          perHook: {
            PostToolUse: ["lint", "unit"],
            PreCommit: ["lint", "security"],
            Stop: ["lint", "unit", "security"],
          },
        },
      }),
    );
    await migrateConfig(cwd, "0.12.0", true);
    const cfg = JSON.parse(await readFile(file, "utf8"));
    expect(cfg.commands.lintChanged).toBe("npx eslint {files}");
    expect(cfg.commands.testChanged).toBe("npx jest --findRelatedTests --passWithNoTests {files}");
    expect(cfg.verify.perHook.PostToolUse).toEqual([]);
    expect(cfg.verify.required).toEqual(["lint", "typecheck", "unit", "security"]);
    expect(cfg.verify.perHook.Stop).toEqual(["lint", "typecheck", "unit", "security"]);
    expect(cfg.verify.perHook.PreCommit).toEqual(["lint", "security"]); // not a full profile

    // 0.11's [lint] default goes too; a profile the user chose is theirs.
    for (const [before, after] of [
      [["lint"], []],
      [
        ["lint", "unit", "design"],
        ["lint", "unit", "design"],
      ],
    ]) {
      await writeFile(
        file,
        JSON.stringify({ ...base, verify: { perHook: { PostToolUse: before } } }),
      );
      await migrateConfig(cwd, "0.12.0", true);
      expect(JSON.parse(await readFile(file, "utf8")).verify.perHook.PostToolUse).toEqual(after);
    }
  });
});
