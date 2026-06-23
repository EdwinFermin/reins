import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildDefaultConfig } from "../config/defaults";
import type { Preset, Runtime } from "../config/schema";
import { detectStack } from "../detect";
import type { StackProfile } from "../detect/types";
import { upsertGitExclude } from "../fs/git-exclude";
import { applyFiles, type WriteOutcome } from "../fs/idempotent-write";
import { pathExists } from "../fs/read";
import { writeManifest, type HarnessManifest } from "../manifest/harness-manifest";
import { buildHarnessFiles } from "../render/catalog";
import { buildTemplateContext } from "../render/context";

export interface RunInitOptions {
  cwd: string;
  preset: Preset;
  runtime?: Runtime;
  harnessVersion: string;
  dryRun?: boolean;
  force?: boolean;
  installGitHook?: boolean;
  writeCi?: boolean;
  /** Ghost mode: keep the harness out of git via `.git/info/exclude` (no CI, no tracked `.gitignore`). */
  gitExclude?: boolean;
}

export interface RunInitResult {
  preset: Preset;
  runtime: Runtime;
  profile: StackProfile;
  outcomes: WriteOutcome[];
  hasGit: boolean;
  gitHookInstalled: boolean;
  /** True when the harness was excluded from git via `.git/info/exclude`. */
  gitExcluded: boolean;
  /** Set when `--ghost` was requested but the directory is not a git repo. */
  gitExcludeSkippedNoGit: boolean;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Detect the stack, render the harness, and write it idempotently. */
export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  const { cwd } = opts;
  const runtime: Runtime = opts.runtime ?? "claude";
  const profile = await detectStack(cwd);
  const config = buildDefaultConfig({
    profile,
    preset: opts.preset,
    runtime,
    harnessVersion: opts.harnessVersion,
  });
  const ctx = buildTemplateContext(config, {
    projectName: path.basename(cwd),
    date: new Date().toISOString().slice(0, 10),
  });

  const gitExclude = opts.gitExclude === true;

  let files = buildHarnessFiles(config, ctx);
  // A non-committed CI workflow never runs, so ghost mode always skips it.
  if (opts.writeCi === false || gitExclude) files = files.filter((f) => f.templateId !== "ci");
  // Ghost mode tracks ignores in `.git/info/exclude`, not the committed `.gitignore`.
  if (gitExclude) files = files.filter((f) => f.templateId !== "gitignore");

  const backupRoot = path.join(cwd, ".reins-backup", stamp());
  const outcomes = await applyFiles(files, {
    cwd,
    backupRoot,
    dryRun: opts.dryRun,
    force: opts.force,
  });

  const hasGit = await pathExists(path.join(cwd, ".git"));

  let gitExcluded = false;
  let gitExcludeSkippedNoGit = false;
  if (gitExclude) {
    if (hasGit) {
      await upsertGitExclude(
        cwd,
        outcomes.map((o) => o.destRel),
        { dryRun: opts.dryRun },
      );
      gitExcluded = true;
    } else {
      gitExcludeSkippedNoGit = true;
    }
  }

  const manifest: HarnessManifest = {
    harnessVersion: opts.harnessVersion,
    preset: opts.preset,
    runtime,
    generatedAt: new Date().toISOString(),
    ...(gitExcluded ? { gitExcluded: true } : {}),
    files: outcomes.map((o) => ({ path: o.destRel, templateId: o.templateId, hash: o.hash })),
  };
  await writeManifest(cwd, manifest, opts.dryRun);

  let gitHookInstalled = false;
  if (opts.installGitHook !== false && hasGit && !opts.dryRun) {
    const src = path.join(cwd, ".reins", "hooks", "pre-commit");
    const dest = path.join(cwd, ".git", "hooks", "pre-commit");
    if ((await pathExists(src)) && !(await pathExists(dest))) {
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(src, dest);
      await chmod(dest, 0o755);
      gitHookInstalled = true;
    }
  }

  return {
    preset: opts.preset,
    runtime,
    profile,
    outcomes,
    hasGit,
    gitHookInstalled,
    gitExcluded,
    gitExcludeSkippedNoGit,
  };
}
