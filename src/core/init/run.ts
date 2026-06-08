import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildDefaultConfig } from "../config/defaults";
import type { Preset } from "../config/schema";
import { detectStack } from "../detect";
import type { StackProfile } from "../detect/types";
import { applyFiles, type WriteOutcome } from "../fs/idempotent-write";
import { pathExists } from "../fs/read";
import { writeManifest, type HarnessManifest } from "../manifest/harness-manifest";
import { buildHarnessFiles } from "../render/catalog";
import { buildTemplateContext } from "../render/context";

export interface RunInitOptions {
  cwd: string;
  preset: Preset;
  harnessVersion: string;
  dryRun?: boolean;
  force?: boolean;
  installGitHook?: boolean;
  writeCi?: boolean;
}

export interface RunInitResult {
  preset: Preset;
  profile: StackProfile;
  outcomes: WriteOutcome[];
  hasGit: boolean;
  gitHookInstalled: boolean;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Detect the stack, render the harness, and write it idempotently. */
export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  const { cwd } = opts;
  const profile = await detectStack(cwd);
  const config = buildDefaultConfig({
    profile,
    preset: opts.preset,
    harnessVersion: opts.harnessVersion,
  });
  const ctx = buildTemplateContext(config, {
    projectName: path.basename(cwd),
    date: new Date().toISOString().slice(0, 10),
  });

  let files = buildHarnessFiles(config, ctx);
  if (opts.writeCi === false) files = files.filter((f) => f.templateId !== "ci");

  const backupRoot = path.join(cwd, ".reins-backup", stamp());
  const outcomes = await applyFiles(files, {
    cwd,
    backupRoot,
    dryRun: opts.dryRun,
    force: opts.force,
  });

  const manifest: HarnessManifest = {
    harnessVersion: opts.harnessVersion,
    preset: opts.preset,
    runtime: "claude",
    generatedAt: new Date().toISOString(),
    files: outcomes.map((o) => ({ path: o.destRel, templateId: o.templateId, hash: o.hash })),
  };
  await writeManifest(cwd, manifest, opts.dryRun);

  const hasGit = await pathExists(path.join(cwd, ".git"));
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

  return { preset: opts.preset, profile, outcomes, hasGit, gitHookInstalled };
}
