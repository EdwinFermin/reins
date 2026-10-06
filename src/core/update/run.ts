import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load";
import { detectStack } from "../detect";
import { backupFile } from "../fs/backup";
import { upsertGitExclude } from "../fs/git-exclude";
import { applyFile, type FileKind } from "../fs/idempotent-write";
import { readJsonIfExists, readTextIfExists } from "../fs/read";
import {
  readManifest,
  writeManifest,
  type HarnessManifest,
  type ManifestEntry,
} from "../manifest/harness-manifest";
import { buildHarnessFiles } from "../render/catalog";
import { buildTemplateContext } from "../render/context";
import { normalizeText, sha256 } from "../util/hash";

export type UpdateAction = "skip" | "updated" | "kept-user" | "conflict" | "added" | "merged";

export interface UpdateEntry {
  path: string;
  templateId: string;
  action: UpdateAction;
  note?: string;
}

export interface UpdateResult {
  installed: boolean;
  fromVersion: string;
  toVersion: string;
  applied: boolean;
  entries: UpdateEntry[];
  conflicts: UpdateEntry[];
}

export interface RunUpdateOptions {
  cwd: string;
  harnessVersion: string;
  apply?: boolean;
  force?: boolean;
  only?: string;
}

/** Three-way decision from content hashes (disk vs manifest baseline vs new template). */
export function classifyThreeWay(
  diskHash: string | null,
  baseHash: string | undefined,
  newHash: string,
): UpdateAction {
  if (diskHash == null) return "added";
  if (diskHash === newHash) return "skip";
  const userModified = baseHash != null && diskHash !== baseHash;
  const templateChanged = baseHash == null || newHash !== baseHash;
  if (!userModified) return "updated";
  if (!templateChanged) return "kept-user";
  return "conflict";
}

const MERGE_KINDS = new Set<FileKind>(["settings-json", "gitignore", "claude-md", "agents-md"]);

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function matchGlob(pattern: string, p: string): boolean {
  if (!pattern.includes("*")) return p === pattern || p.includes(pattern);
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(p);
}

async function writeNormalized(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, normalizeText(content), "utf8");
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function ensureObject(parent: Json, key: string): Json {
  if (!isObj(parent[key])) parent[key] = {};
  return parent[key] as Json;
}

/**
 * Additive migration of `reins.config.json` (otherwise create-only): bump
 * `harnessVersion` and surface config keys introduced by newer versions with
 * their defaults, so they are discoverable. Never changes a value the user set;
 * the one exception is replacing a former Reins default that proved harmful
 * (the per-edit full test run), and only when it is still exactly that default.
 * Returns the keys it added.
 */
export async function migrateConfig(
  cwd: string,
  version: string,
  apply: boolean,
): Promise<string[]> {
  const file = path.join(cwd, "reins.config.json");
  const raw = await readJsonIfExists<Json>(file);
  if (!raw) return [];
  const added: string[] = [];

  const verify = ensureObject(raw, "verify");
  if (!isObj(verify.stop)) {
    verify.stop = { baselinePreexisting: true, maxRepeatBlocks: 3 };
    added.push("verify.stop");
  }
  const depsAudit = ensureObject(ensureObject(raw, "security"), "depsAudit");
  if (!Array.isArray(depsAudit.ignore)) {
    depsAudit.ignore = [];
    added.push("security.depsAudit.ignore");
  }

  // v0.11 — fast lanes. Scoped lint/test commands for `verify --changed`,
  // detected from the stack (only beside a configured full command).
  const commands = ensureObject(raw, "commands");
  if (!("lintChanged" in commands) || !("testChanged" in commands)) {
    const profile = await detectStack(cwd).catch(() => null);
    for (const [key, base] of [
      ["lintChanged", "lint"],
      ["testChanged", "test"],
    ] as const) {
      if (key in commands) continue;
      commands[key] = commands[base] ? (profile?.commands[key]?.value ?? null) : null;
      added.push(`commands.${key}`);
    }
  }
  if (typeof verify.cache !== "boolean") {
    verify.cache = true;
    added.push("verify.cache");
  }
  // v0.12 — verify per milestone, not per edit. The per-edit hook's former
  // defaults ([lint, unit] ≤ 0.10, [lint] in 0.11) become "run nothing"; a
  // profile the user chose is left alone. (The hook entry itself is removed
  // from settings.json by the settings merge.)
  const perHook = ensureObject(verify, "perHook");
  const post = JSON.stringify(perHook.PostToolUse ?? null);
  if (post === '["lint","unit"]' || post === '["lint"]') {
    perHook.PostToolUse = [];
    added.push(`verify.perHook.PostToolUse=[] (was the old ${post} default)`);
  }
  if (!Array.isArray(verify.gateAgents)) {
    verify.gateAgents = ["implementer"];
    added.push("verify.gateAgents");
  }
  // v0.12 — typecheck joins the gate wherever a typecheck command is configured
  // (it was configured but never run): in `required`, and in the milestone
  // profiles (Stop / SubagentStop / CI) that already run unit tests. Per-edit
  // and pre-commit profiles stay as they are.
  if (commands.typecheck) {
    const lists: [string, unknown][] = [
      ["verify.required", verify.required],
      ...["Stop", "SubagentStop", "CI"].map(
        (hook) => [`verify.perHook.${hook}`, perHook[hook]] as [string, unknown],
      ),
    ];
    for (const [name, list] of lists) {
      if (!Array.isArray(list) || list.includes("typecheck")) continue;
      if (name !== "verify.required" && !list.includes("unit")) continue;
      const at = list.indexOf("lint");
      list.splice(at >= 0 ? at + 1 : 0, 0, "typecheck");
      added.push(`${name} += typecheck`);
    }
  }
  if (!isObj(raw.router)) {
    raw.router = { provider: "auto" };
    added.push("router");
  }

  const bump = raw.harnessVersion !== version;
  raw.harnessVersion = version;
  if (apply && (bump || added.length))
    await writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return added;
}

/** Update the harness templates to the CLI version, preserving user changes. */
export async function runUpdate(opts: RunUpdateOptions): Promise<UpdateResult> {
  const { cwd } = opts;
  const apply = opts.apply === true;
  const config = await loadConfig(cwd);
  const manifest = await readManifest(cwd);

  if (!config || !manifest) {
    return {
      installed: false,
      fromVersion: manifest?.harnessVersion ?? "?",
      toVersion: opts.harnessVersion,
      applied: false,
      entries: [],
      conflicts: [],
    };
  }

  const ctx = buildTemplateContext(config, {
    projectName: path.basename(cwd),
    date: new Date().toISOString().slice(0, 10),
  });
  const gitExcluded = manifest.gitExcluded === true;

  let files = buildHarnessFiles(config, ctx);
  // Ghost installs track ignores in `.git/info/exclude` and skip CI, so neither
  // the committed `.gitignore` nor the workflow are part of the update set.
  if (gitExcluded)
    files = files.filter((f) => f.templateId !== "ci" && f.templateId !== "gitignore");
  if (opts.only) files = files.filter((f) => matchGlob(opts.only!, f.destRel));

  const baseline = new Map<string, ManifestEntry>(manifest.files.map((e) => [e.templateId, e]));
  const backupRoot = path.join(cwd, ".reins-backup", stamp());
  const entries: UpdateEntry[] = [];
  const newFiles: ManifestEntry[] = [];

  for (const file of files) {
    const kind = file.kind ?? "plain";
    const base = baseline.get(file.templateId);

    // Living state (progress, feature_list, reins.config) is never rewritten here.
    if (kind === "create-only") {
      if (base) newFiles.push(base);
      continue;
    }

    // Marker/merge files: the idempotent writer already preserves user content.
    if (MERGE_KINDS.has(kind)) {
      const outcome = await applyFile(file, { cwd, backupRoot, dryRun: !apply });
      entries.push({
        path: outcome.destRel,
        templateId: file.templateId,
        action: outcome.action === "skip" ? "skip" : "merged",
        note: outcome.note,
      });
      newFiles.push({ path: outcome.destRel, templateId: file.templateId, hash: outcome.hash });
      continue;
    }

    // plain / ci-workflow: three-way merge.
    const abs = path.join(cwd, file.destRel);
    const newHash = sha256(normalizeText(file.content));
    const diskText = await readTextIfExists(abs);
    const diskHash = diskText == null ? null : sha256(normalizeText(diskText));
    const action = classifyThreeWay(diskHash, base?.hash, newHash);

    if (action === "skip") {
      entries.push({ path: file.destRel, templateId: file.templateId, action });
      newFiles.push({ path: file.destRel, templateId: file.templateId, hash: newHash });
    } else if (action === "added" || action === "updated") {
      if (apply) await writeNormalized(abs, file.content);
      entries.push({ path: file.destRel, templateId: file.templateId, action });
      newFiles.push({ path: file.destRel, templateId: file.templateId, hash: newHash });
    } else if (action === "kept-user") {
      entries.push({
        path: file.destRel,
        templateId: file.templateId,
        action,
        note: "your changes kept (template unchanged)",
      });
      newFiles.push({ path: file.destRel, templateId: file.templateId, hash: diskHash! });
    } else if (apply && opts.force) {
      await backupFile(abs, backupRoot, file.destRel);
      if (diskText != null) await writeFile(abs + ".orig", diskText, "utf8");
      await writeNormalized(abs, file.content);
      entries.push({
        path: file.destRel,
        templateId: file.templateId,
        action: "updated",
        note: "conflict resolved; your version saved as .orig",
      });
      newFiles.push({ path: file.destRel, templateId: file.templateId, hash: newHash });
    } else {
      entries.push({
        path: file.destRel,
        templateId: file.templateId,
        action: "conflict",
        note: apply ? "both changed — re-run with --force to overwrite" : "both changed",
      });
      newFiles.push({
        path: file.destRel,
        templateId: file.templateId,
        hash: base?.hash ?? newHash,
      });
    }
  }

  const addedKeys = await migrateConfig(cwd, opts.harnessVersion, apply);
  if (addedKeys.length) {
    entries.push({
      path: "reins.config.json",
      templateId: "reins-config",
      action: "merged",
      note: `added ${addedKeys.join(", ")} (defaults)`,
    });
  }

  const conflicts = entries.filter((e) => e.action === "conflict");

  if (apply) {
    // Re-sync the local ignore so new agents/commands from this version are covered.
    if (gitExcluded)
      await upsertGitExclude(
        cwd,
        newFiles.map((f) => f.path),
      );
    const updated: HarnessManifest = {
      harnessVersion: opts.harnessVersion,
      preset: config.preset,
      runtime: config.runtime,
      generatedAt: new Date().toISOString(),
      ...(gitExcluded ? { gitExcluded: true } : {}),
      files: newFiles,
    };
    await writeManifest(cwd, updated);
  }

  return {
    installed: true,
    fromVersion: manifest.harnessVersion,
    toVersion: opts.harnessVersion,
    applied: apply,
    entries,
    conflicts,
  };
}
