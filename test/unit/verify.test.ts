import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

describe("runVerify — feature-list dependsOn enforcement", () => {
  async function check(features: unknown[]): Promise<string> {
    const cwd = await tmp();
    await writeFile(path.join(cwd, "feature_list.json"), JSON.stringify({ version: 1, features }));
    const report = await runVerify({ cwd, config: makeConfig({}), only: ["feature-list"] });
    return report.results[0]?.status ?? "missing";
  }

  it("fails on a dependsOn that points at an unknown feature", async () => {
    expect(await check([{ slug: "a", state: "pending", dependsOn: ["ghost"] }])).toBe("fail");
  });

  it("fails on a dependency cycle", async () => {
    expect(
      await check([
        { slug: "a", state: "pending", dependsOn: ["b"] },
        { slug: "b", state: "pending", dependsOn: ["a"] },
      ]),
    ).toBe("fail");
  });

  it("fails when a feature is in_progress before its dependency is done", async () => {
    expect(
      await check([
        { slug: "a", state: "pending", dependsOn: [] },
        { slug: "b", state: "in_progress", dependsOn: ["a"] },
      ]),
    ).toBe("fail");
  });

  it("passes once the dependency is done", async () => {
    expect(
      await check([
        { slug: "a", state: "done", dependsOn: [] },
        { slug: "b", state: "in_progress", dependsOn: ["a"] },
      ]),
    ).toBe("pass");
  });

  it("accepts approved as a valid, non-active state", async () => {
    expect(
      await check([
        { slug: "a", state: "approved", dependsOn: [] },
        { slug: "b", state: "analyzing", dependsOn: [] },
      ]),
    ).toBe("pass");
  });

  it("allows an approved feature whose dependency is not done (not premature)", async () => {
    expect(
      await check([
        { slug: "a", state: "pending", dependsOn: [] },
        { slug: "b", state: "approved", dependsOn: ["a"] },
      ]),
    ).toBe("pass");
  });
});

describe("runVerify — feature-list discovery gate (sdd)", () => {
  it("fails when an sdd feature reaches spec_ready without a discovery.md", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "feature_list.json"),
      JSON.stringify({ version: 1, features: [{ slug: "glass", state: "spec_ready" }] }),
    );
    const config = makeConfig({ preset: "sdd" });
    const report = await runVerify({ cwd, config, only: ["feature-list"] });
    expect(report.results[0]?.status).toBe("fail");
  });

  it("passes once the feature has a non-empty discovery.md", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "feature_list.json"),
      JSON.stringify({ version: 1, features: [{ slug: "glass", state: "spec_ready" }] }),
    );
    await mkdir(path.join(cwd, "specs", "glass"), { recursive: true });
    await writeFile(
      path.join(cwd, "specs", "glass", "discovery.md"),
      "# Discovery\nreal findings\n",
    );
    const config = makeConfig({ preset: "sdd" });
    const report = await runVerify({ cwd, config, only: ["feature-list"] });
    expect(report.results[0]?.status).toBe("pass");
  });

  it("does not require discovery under the lite preset", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "feature_list.json"),
      JSON.stringify({ version: 1, features: [{ slug: "glass", state: "in_progress" }] }),
    );
    const config = makeConfig({ preset: "lite" });
    const report = await runVerify({ cwd, config, only: ["feature-list"] });
    expect(report.results[0]?.status).toBe("pass");
  });

  it("fails when an approved sdd feature has no discovery.md", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "feature_list.json"),
      JSON.stringify({ version: 1, features: [{ slug: "glass", state: "approved" }] }),
    );
    const config = makeConfig({ preset: "sdd" });
    const report = await runVerify({ cwd, config, only: ["feature-list"] });
    expect(report.results[0]?.status).toBe("fail");
  });

  it("fails when two features occupy the active slot (analyzing + in_progress)", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "feature_list.json"),
      JSON.stringify({
        version: 1,
        features: [
          { slug: "a", state: "analyzing" },
          { slug: "b", state: "in_progress" },
        ],
      }),
    );
    const config = makeConfig({ preset: "lite" });
    const report = await runVerify({ cwd, config, only: ["feature-list"] });
    expect(report.results[0]?.status).toBe("fail");
  });
});

describe("runVerify — feature-list approved-spec gate (sdd)", () => {
  async function setup(specFiles: string[]): Promise<string> {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "feature_list.json"),
      JSON.stringify({ version: 1, features: [{ slug: "glass", state: "approved" }] }),
    );
    await mkdir(path.join(cwd, "specs", "glass"), { recursive: true });
    await writeFile(
      path.join(cwd, "specs", "glass", "discovery.md"),
      "# Discovery\nreal findings\n",
    );
    for (const file of specFiles) {
      await writeFile(path.join(cwd, "specs", "glass", file), `# ${file}\ncontent\n`);
    }
    return cwd;
  }

  it("fails when an approved feature is missing a spec file", async () => {
    const cwd = await setup(["requirements.md", "design.md"]); // no tasks.md
    const config = makeConfig({ preset: "sdd" });
    const report = await runVerify({ cwd, config, only: ["feature-list"] });
    expect(report.results[0]?.status).toBe("fail");
    expect(report.results[0]?.details).toContain("tasks.md");
  });

  it("passes when the approved feature has discovery + the three spec files", async () => {
    const cwd = await setup(["requirements.md", "design.md", "tasks.md"]);
    const config = makeConfig({ preset: "sdd" });
    const report = await runVerify({ cwd, config, only: ["feature-list"] });
    expect(report.results[0]?.status).toBe("pass");
  });

  it("does not require the spec files for spec_ready (only approved)", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "feature_list.json"),
      JSON.stringify({ version: 1, features: [{ slug: "glass", state: "spec_ready" }] }),
    );
    await mkdir(path.join(cwd, "specs", "glass"), { recursive: true });
    await writeFile(
      path.join(cwd, "specs", "glass", "discovery.md"),
      "# Discovery\nreal findings\n",
    );
    const config = makeConfig({ preset: "sdd" });
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

describe("runVerify — design slop scan", () => {
  it("skips cleanly when there are no UI files", async () => {
    const cwd = await tmp();
    await writeFile(path.join(cwd, "server.ts"), "export const x = 1;\n");
    const report = await runVerify({ cwd, config: makeConfig({}), only: ["design"] });
    expect(report.results[0]?.status).toBe("skip");
  });

  it("blocks on placeholder Lorem ipsum in a UI file", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "Hero.tsx"),
      "export const Hero = () => <p>Lorem ipsum dolor sit amet</p>;\n",
    );
    const report = await runVerify({ cwd, config: makeConfig({}), only: ["design"] });
    expect(report.results[0]?.status).toBe("fail");
    expect(report.results[0]?.details).toContain("Lorem ipsum");
  });

  it("blocks on gradient text (bg-clip-text + text-transparent)", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "Title.tsx"),
      'export const T = () => <h1 className="bg-gradient-to-r bg-clip-text text-transparent">Hi</h1>;\n',
    );
    const report = await runVerify({ cwd, config: makeConfig({}), only: ["design"] });
    expect(report.results[0]?.status).toBe("fail");
  });

  it("passes (advisory only) on a generic AI gradient at the default failOn", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "Card.tsx"),
      'export const C = () => <div className="bg-gradient-to-r from-indigo-500 to-pink-500">x</div>;\n',
    );
    const report = await runVerify({ cwd, config: makeConfig({}), only: ["design"] });
    expect(report.results[0]?.status).toBe("pass");
    expect(report.results[0]?.summary).toContain("advisory");
  });

  it("fails on advisory tells when failOn is advisory", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "Card.tsx"),
      'export const C = () => <div className="bg-gradient-to-r from-indigo-500 to-pink-500">x</div>;\n',
    );
    const config = makeConfig({ design: { slopScan: { failOn: "advisory" } } });
    const report = await runVerify({ cwd, config, only: ["design"] });
    expect(report.results[0]?.status).toBe("fail");
  });

  it("passes a clean UI file with no tells", async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, "Button.tsx"),
      'export const B = () => <button className="px-4 py-2 rounded">Save</button>;\n',
    );
    const report = await runVerify({ cwd, config: makeConfig({}), only: ["design"] });
    expect(report.results[0]?.status).toBe("pass");
  });

  it("can be disabled via config", async () => {
    const cwd = await tmp();
    await writeFile(path.join(cwd, "Hero.tsx"), "<p>Lorem ipsum</p>\n");
    const config = makeConfig({ design: { slopScan: { enabled: false } } });
    const report = await runVerify({ cwd, config, only: ["design"] });
    expect(report.results[0]?.status).toBe("skip");
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
