import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ReinsConfigSchema, type ReinsConfig } from "../../src/core/config/schema";
import { nodeDetector } from "../../src/core/detect/node";
import { runShell } from "../../src/core/exec/run-command";
import { readHookPayload } from "../../src/core/verify/hook-input";
import { runVerify } from "../../src/core/verify/runner";

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "reins-fast-"));
}

async function gitRepo(): Promise<string> {
  const cwd = await tmp();
  await runShell(
    "git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false",
    { cwd },
  );
  await writeFile(path.join(cwd, "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(cwd, "b.ts"), "export const b = 1;\n");
  await writeFile(path.join(cwd, "notes.md"), "# notes\n");
  await runShell("git add -A && git commit -qm init", { cwd });
  return cwd;
}

function makeConfig(overrides: Record<string, unknown>): ReinsConfig {
  return ReinsConfigSchema.parse({
    harnessVersion: "0.0.0",
    preset: "lite",
    stack: { language: "node" },
    commands: {},
    security: { depsAudit: { enabled: false }, secretScan: { enabled: false } },
    ...overrides,
  });
}

/** A command that prints its file arguments and fails, so they land in `details`. */
const ECHO_ARGS_AND_FAIL = `node -e "console.log('ARGS:' + process.argv.slice(1).join(',')); process.exit(1)" {files}`;

/** A command that counts its runs in a file outside the project. */
async function counter(): Promise<{ cmd: string; runs: () => Promise<number> }> {
  const file = path.join(await tmp(), "count");
  await writeFile(file, "");
  return {
    cmd: `node -e "require('fs').appendFileSync(${JSON.stringify(JSON.stringify(file)).slice(1, -1)}, 'x')"`,
    runs: async () => (await readFile(file, "utf8")).length,
  };
}

describe("verify --changed — scoped lint/test", () => {
  it("runs the scoped command on changed source files only (incl. untracked)", async () => {
    const cwd = await gitRepo();
    await writeFile(path.join(cwd, "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(cwd, "new.tsx"), "export const n = 1;\n");
    await writeFile(path.join(cwd, "notes.md"), "# changed\n");
    const config = makeConfig({
      commands: { lint: "exit 1", lintChanged: ECHO_ARGS_AND_FAIL },
    });
    const report = await runVerify({ cwd, config, only: ["lint"], changed: true });
    const lint = report.results[0]!;
    expect(lint.status).toBe("fail");
    expect(lint.details).toContain("ARGS:a.ts,new.tsx"); // not b.ts, not notes.md
  });

  it("prefers the file from the hook payload over git", async () => {
    const cwd = await gitRepo();
    await writeFile(path.join(cwd, "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(cwd, "b.ts"), "export const b = 2;\n");
    const config = makeConfig({ commands: { lint: "exit 1", lintChanged: ECHO_ARGS_AND_FAIL } });
    const report = await runVerify({
      cwd,
      config,
      only: ["lint"],
      changed: true,
      changedFiles: [path.join(cwd, "b.ts")],
    });
    expect(report.results[0]!.details).toContain("ARGS:b.ts");
    expect(report.results[0]!.details).not.toContain("a.ts");
  });

  it("skips when no source file changed, and falls back to the full command without a scoped one", async () => {
    const cwd = await gitRepo();
    await writeFile(path.join(cwd, "notes.md"), "# only docs\n");
    const scoped = makeConfig({ commands: { test: "exit 1", testChanged: ECHO_ARGS_AND_FAIL } });
    const skipped = await runVerify({ cwd, config: scoped, only: ["unit"], changed: true });
    expect(skipped.results[0]!.status).toBe("skip");

    const full = makeConfig({ commands: { test: 'node -e "process.exit(0)"' } });
    const ran = await runVerify({ cwd, config: full, only: ["unit"], changed: true });
    expect(ran.results[0]!.status).toBe("pass");
  });

  it("never scans everything when nothing changed", async () => {
    const cwd = await gitRepo();
    await writeFile(path.join(cwd, "leak.ts"), 'const k = "AKIAABCDEFGHIJKLMNOP";\n');
    await runShell("git add -A && git commit -qm leak", { cwd });
    const config = makeConfig({
      security: { depsAudit: { enabled: false }, secretScan: { enabled: true, tool: "builtin" } },
    });
    const clean = await runVerify({ cwd, config, only: ["security"], changed: true });
    expect(clean.results[0]!.status).toBe("pass"); // the committed file isn't "changed"
    const full = await runVerify({ cwd, config, only: ["security"] });
    expect(full.results[0]!.status).toBe("fail");
  });
});

describe("verify — pass-result cache", () => {
  it("reuses a pass on an unchanged tree and re-runs after an edit", async () => {
    const cwd = await gitRepo();
    const c = await counter();
    const config = makeConfig({ commands: { test: c.cmd } });

    const first = await runVerify({ cwd, config, only: ["unit"] });
    expect(first.results[0]!.status).toBe("pass");
    const second = await runVerify({ cwd, config, only: ["unit"], hook: "Stop" });
    expect(second.results[0]!.summary).toContain("cached");
    expect(await c.runs()).toBe(1);

    await writeFile(path.join(cwd, "a.ts"), "export const a = 3;\n");
    await runVerify({ cwd, config, only: ["unit"] });
    expect(await c.runs()).toBe(2);
  });

  it("ignores harness state for tests but not for lint", async () => {
    const cwd = await gitRepo();
    const unit = await counter();
    const lint = await counter();
    const config = makeConfig({ commands: { test: unit.cmd, lint: lint.cmd } });
    await runVerify({ cwd, config, only: ["unit", "lint"] });
    await mkdir(path.join(cwd, "progress"), { recursive: true });
    await writeFile(path.join(cwd, "progress", "review_x.md"), "# Review\n");
    await runVerify({ cwd, config, only: ["unit", "lint"] });
    expect(await unit.runs()).toBe(1);
    expect(await lint.runs()).toBe(2);
  });

  it("never caches failures, never serves CI, and honors noCache / verify.cache=false", async () => {
    const cwd = await gitRepo();
    const failing = makeConfig({ commands: { test: 'node -e "process.exit(1)"' } });
    await runVerify({ cwd, config: failing, only: ["unit"] });
    const again = await runVerify({ cwd, config: failing, only: ["unit"] });
    expect(again.results[0]!.status).toBe("fail");

    const c = await counter();
    const config = makeConfig({ commands: { test: c.cmd } });
    await runVerify({ cwd, config, only: ["unit"] });
    await runVerify({ cwd, config, only: ["unit"], hook: "CI" });
    await runVerify({ cwd, config, only: ["unit"], noCache: true });
    const off = makeConfig({ commands: { test: c.cmd }, verify: { cache: false } });
    await runVerify({ cwd, config: off, only: ["unit"] });
    expect(await c.runs()).toBe(4);
  });
});

describe("hook payload", () => {
  it("reads the session id and the edited file", async () => {
    const stdin = new PassThrough();
    const pending = readHookPayload(stdin);
    stdin.end(
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "PostToolUse",
        tool_input: { file_path: "/repo/src/a.ts", content: "…" },
      }),
    );
    expect(await pending).toMatchObject({
      sessionId: "s1",
      filePaths: ["/repo/src/a.ts"],
      agentType: null,
    });
  });
});

describe("node detector — scoped commands", () => {
  it("detects eslint + jest (jest-expo) and vitest", async () => {
    const expo = await tmp();
    await writeFile(
      path.join(expo, "package.json"),
      JSON.stringify({
        scripts: { test: "jest --watchAll=false", lint: "expo lint" },
        devDependencies: { eslint: "^9", "jest-expo": "^52", expo: "^52" },
      }),
    );
    const p1 = await nodeDetector.detect(expo);
    expect(p1?.commands.lintChanged?.value).toBe("npx eslint {files}");
    expect(p1?.commands.testChanged?.value).toBe(
      "npx jest --findRelatedTests --passWithNoTests {files}",
    );

    const vite = await tmp();
    await writeFile(
      path.join(vite, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^2" } }),
    );
    const p2 = await nodeDetector.detect(vite);
    expect(p2?.commands.testChanged?.value).toBe(
      "npx vitest related --run --passWithNoTests {files}",
    );
    expect(p2?.commands.lintChanged).toBeUndefined();
  });
});
