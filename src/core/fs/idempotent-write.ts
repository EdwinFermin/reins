import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeJson, normalizeText, sha256 } from "../util/hash";
import { backupFile } from "./backup";
import { HTML_COMMENT, hasManagedBlock, upsertManagedBlock, wrapManagedBlock } from "./markers";
import { deepMergeSettings } from "./merge";

/** How a rendered file should be reconciled with whatever already exists. */
export type FileKind =
  | "plain"
  | "settings-json"
  | "gitignore"
  | "claude-md"
  | "agents-md"
  | "ci-workflow"
  | "create-only";

export interface RenderedFile {
  templateId: string;
  destRel: string;
  content: string;
  kind?: FileKind;
}

export interface WriteOptions {
  cwd: string;
  backupRoot: string;
  dryRun?: boolean;
  force?: boolean;
}

export type WriteAction =
  | "create"
  | "skip"
  | "merge"
  | "append-block"
  | "backup-overwrite"
  | "sidecar"
  | "suffix";

export interface WriteOutcome {
  templateId: string;
  destRel: string;
  action: WriteAction;
  note?: string;
  hash: string;
}

async function readTextOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function write(p: string, content: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content, "utf8");
}

function siblingPath(destRel: string, name: string): string {
  return path.join(path.dirname(destRel), name);
}

function suffixPath(destRel: string, suffix: string): string {
  const parsed = path.parse(destRel);
  return path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
}

/** Reconcile a single rendered file against the working tree. */
export async function applyFile(file: RenderedFile, opts: WriteOptions): Promise<WriteOutcome> {
  const kind = file.kind ?? "plain";
  const abs = path.join(opts.cwd, file.destRel);
  const existing = await readTextOrNull(abs);
  const dryRun = Boolean(opts.dryRun);

  const result = (
    action: WriteAction,
    hash: string,
    destRel = file.destRel,
    note?: string,
  ): WriteOutcome => ({
    templateId: file.templateId,
    destRel,
    action,
    note,
    hash,
  });

  if (kind === "settings-json") {
    const normalizedIncoming = normalizeJson(file.content);
    if (existing == null) {
      await write(abs, normalizedIncoming, dryRun);
      return result("create", sha256(normalizedIncoming));
    }
    try {
      const merged =
        JSON.stringify(deepMergeSettings(JSON.parse(existing), JSON.parse(file.content)), null, 2) +
        "\n";
      if (normalizeText(merged) === normalizeText(existing)) {
        return result("skip", sha256(merged));
      }
      if (!opts.force) await backupFile(abs, opts.backupRoot, file.destRel);
      await write(abs, merged, dryRun);
      return result("merge", sha256(merged));
    } catch {
      if (!opts.force) await backupFile(abs, opts.backupRoot, file.destRel);
      await write(abs, normalizedIncoming, dryRun);
      return result(
        "backup-overwrite",
        sha256(normalizedIncoming),
        file.destRel,
        "existing file was not valid JSON",
      );
    }
  }

  if (kind === "gitignore") {
    const body = normalizeText(file.content).trimEnd();
    if (existing == null) {
      const content = wrapManagedBlock(body) + "\n";
      await write(abs, content, dryRun);
      return result("create", sha256(content));
    }
    const updated = upsertManagedBlock(existing, body);
    if (updated === existing) return result("skip", sha256(updated));
    await write(abs, updated, dryRun);
    return result("append-block", sha256(updated));
  }

  // Markdown instruction files (CLAUDE.md, AGENTS.md) are reconciled by a
  // managed block: Reins owns its section and leaves anything the user adds
  // alone. When an unmanaged file already exists, write a sidecar instead.
  if (kind === "claude-md" || kind === "agents-md") {
    const sidecarName = kind === "claude-md" ? "CLAUDE.reins.md" : "AGENTS.reins.md";
    const importHint =
      kind === "claude-md"
        ? "Existing CLAUDE.md left intact; add `@CLAUDE.reins.md` to import the harness instructions."
        : "Existing AGENTS.md left intact; merge in `AGENTS.reins.md` to load the harness instructions.";
    const body = normalizeText(file.content).trim();
    if (existing == null) {
      const content = wrapManagedBlock(body, HTML_COMMENT) + "\n";
      await write(abs, content, dryRun);
      return result("create", sha256(content));
    }
    if (hasManagedBlock(existing, HTML_COMMENT)) {
      const updated = upsertManagedBlock(existing, body, HTML_COMMENT);
      if (updated === existing) return result("skip", sha256(updated));
      await write(abs, updated, dryRun);
      return result("merge", sha256(updated));
    }
    const sidecarRel = siblingPath(file.destRel, sidecarName);
    const content = normalizeText(file.content);
    await write(path.join(opts.cwd, sidecarRel), content, dryRun);
    return result("sidecar", sha256(content), sidecarRel, importHint);
  }

  if (kind === "create-only") {
    // Living state (feature_list.json, progress/*, config): never clobber.
    if (existing == null) {
      const normalized = normalizeText(file.content);
      await write(abs, normalized, dryRun);
      return result("create", sha256(normalized));
    }
    return result("skip", sha256(normalizeText(existing)));
  }

  // plain + ci-workflow share create/skip/diverge logic; ci diverges to a suffix.
  const normalized = normalizeText(file.content);
  if (existing == null) {
    await write(abs, normalized, dryRun);
    return result("create", sha256(normalized));
  }
  if (normalizeText(existing) === normalized) {
    return result("skip", sha256(normalized));
  }
  if (kind === "ci-workflow") {
    const suffixedRel = suffixPath(file.destRel, ".reins");
    await write(path.join(opts.cwd, suffixedRel), normalized, dryRun);
    return result(
      "suffix",
      sha256(normalized),
      suffixedRel,
      "A file with that name already exists; wrote the Reins version alongside it.",
    );
  }
  if (!opts.force) await backupFile(abs, opts.backupRoot, file.destRel);
  await write(abs, normalized, dryRun);
  return result("backup-overwrite", sha256(normalized));
}

/** Reconcile a batch of rendered files; runs sequentially to avoid mkdir races. */
export async function applyFiles(
  files: RenderedFile[],
  opts: WriteOptions,
): Promise<WriteOutcome[]> {
  const outcomes: WriteOutcome[] = [];
  for (const file of files) {
    outcomes.push(await applyFile(file, opts));
  }
  return outcomes;
}
