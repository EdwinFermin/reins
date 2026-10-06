import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReinsConfig } from "../config/schema";
import { runShell } from "../exec/run-command";
import { sha256 } from "../util/hash";
import { lockfileHash } from "./lockfile";
import { filesToScan } from "./scan-files";
import type { CheckResult } from "./types";

/**
 * Per-session state that keeps `verify --hook Stop` from trapping an agent in
 * a loop it cannot fix:
 *
 *  1. Baseline — dependency findings already present when the session started
 *     (same advisories, same lockfile) warn instead of blocking.
 *  2. Repeat guard — after N identical blocks with no file changes in between,
 *     stop blocking and hand the decision to a human.
 *
 * Lives in `.reins/cache/` (never committed).
 */

export const STATE_REL = path.join(".reins", "cache", "verify-session.json");

/** Hooks that fire inside an agent session (and so belong to one). */
export const SESSION_HOOKS = new Set(["PostToolUse", "Stop", "SubagentStop"]);

export interface SessionState {
  version: 1;
  sessionId: string | null;
  startedAt: string;
  /** Lockfile hash when the session started. */
  startLockfileHash: string | null;
  /** Blocking advisories seen by the first audit run against the starting lockfile. */
  baseline: { lockfileHash: string | null; advisories: string[]; recordedAt: string } | null;
  /** Consecutive identical Stop blocks. */
  stopBlocks: BlockCounter | null;
  /** Consecutive identical SubagentStop (implementer gate) blocks. */
  subagentBlocks?: BlockCounter | null;
}

export interface BlockCounter {
  fingerprint: string;
  workspace: string | null;
  count: number;
}

export function sessionTrackingEnabled(config: ReinsConfig): boolean {
  const stop = config.verify.stop;
  return stop.baselinePreexisting || stop.maxRepeatBlocks > 0;
}

export async function loadSessionState(cwd: string): Promise<SessionState | null> {
  try {
    const data = JSON.parse(await readFile(path.join(cwd, STATE_REL), "utf8")) as SessionState;
    return data && data.version === 1 ? data : null;
  } catch {
    return null;
  }
}

export async function saveSessionState(cwd: string, state: SessionState): Promise<void> {
  try {
    const abs = path.join(cwd, STATE_REL);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // Best effort: a read-only tree must never break the gate.
  }
}

/**
 * Return the state for the current session, starting a fresh one when needed.
 *
 * - From SessionStart: always a new session, unless it's the same session id
 *   resuming (resume / compact / clear keep their baseline).
 * - From any other hook: reuse the stored session unless a different session id
 *   shows up (the "first verify of the session" fallback).
 */
export async function beginSession(
  cwd: string,
  opts: { sessionId: string | null; fromSessionStart: boolean; now?: Date },
): Promise<SessionState> {
  const existing = await loadSessionState(cwd);
  const sameId = opts.sessionId != null && existing?.sessionId === opts.sessionId;
  const reuse =
    existing != null && (opts.fromSessionStart ? sameId : opts.sessionId == null || sameId);
  if (reuse) return existing;
  return {
    version: 1,
    sessionId: opts.sessionId,
    startedAt: (opts.now ?? new Date()).toISOString(),
    startLockfileHash: await lockfileHash(cwd),
    baseline: null,
    stopBlocks: null,
  };
}

/** Record the session start (SessionStart hook). Cheap: hashes lockfiles, runs no audit. */
export async function recordSessionStart(
  cwd: string,
  sessionId: string | null,
  now?: Date,
): Promise<void> {
  const state = await beginSession(cwd, { sessionId, fromSessionStart: true, now });
  await saveSessionState(cwd, state);
}

/**
 * Capture the baseline from the first audit of the session — but only while the
 * lockfile is still the one the session started with, so findings the session
 * introduced can never be baselined.
 */
export function recordBaseline(state: SessionState, results: CheckResult[], now?: Date): void {
  if (state.baseline) return;
  const deps = results.find((r) => r.id === "security")?.security?.deps;
  if (!deps || deps.lockfileHash !== state.startLockfileHash) return;
  state.baseline = {
    lockfileHash: deps.lockfileHash,
    advisories: [...deps.blockingAdvisories].sort(),
    recordedAt: (now ?? new Date()).toISOString(),
  };
}

function list(ids: string[], max = 6): string {
  return ids.length <= max
    ? ids.join(", ")
    : `${ids.slice(0, max).join(", ")}, +${ids.length - max} more`;
}

/**
 * Stop baseline: downgrade a security failure to `warn` when it consists solely
 * of dependency advisories that were already there when the session started and
 * the lockfile is unchanged. Returns notices explaining the decision.
 */
export function applyBaseline(state: SessionState, results: CheckResult[]): string[] {
  const sec = results.find((r) => r.id === "security");
  const meta = sec?.security;
  if (!sec || sec.status !== "fail" || !meta?.deps || !meta.depsFailed) return [];
  const deps = meta.deps;
  const baseline = state.baseline;

  // Secret leaks and expired allowlist entries are never "pre-existing noise".
  if (meta.secretsFailed || deps.expired.length) return [];
  if (!baseline) {
    return [
      "security: no baseline for this session (the lockfile changed before the first audit), " +
        "so dependency findings block.",
    ];
  }

  const fresh = deps.blockingAdvisories.filter((a) => !baseline.advisories.includes(a));
  if (deps.lockfileHash !== baseline.lockfileHash) {
    return [
      `security: the lockfile changed this session and dependency findings remain ` +
        `(${list(deps.blockingAdvisories)}) — blocking. Fix them, or revert the dependency change.`,
    ];
  }
  if (fresh.length) {
    return [`security: new dependency advisories since the session started: ${list(fresh)}.`];
  }

  sec.status = "warn";
  sec.summary += " — pre-existing, not blocking Stop";
  return [
    `security: ${deps.blockingAdvisories.length} dependency advisory(ies) were already present ` +
      `when this session started and the lockfile is unchanged (${list(deps.blockingAdvisories)}). ` +
      "Not blocking Stop. Fix them (upgrade the dependency) or, if no fix exists, allowlist each " +
      'one in reins.config.json → security.depsAudit.ignore with { "id", "reason", "until" }.',
  ];
}

/** Strip run-to-run noise (durations, clock times) so identical failures hash identically. */
function normalizeOutput(text: string): string {
  return text
    .replace(/\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/g, "#")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m)\b/g, "#");
}

export function failureFingerprint(failed: CheckResult[]): string {
  return sha256(
    failed
      .map((r) => `${r.id}|${normalizeOutput(r.summary)}|${normalizeOutput(r.details ?? "")}`)
      .join("\n"),
  );
}

const IGNORED_PREFIXES = [".reins/cache/", ".reins-backup/", ".git/"];

/**
 * A cheap fingerprint of the working tree (HEAD + path/size/mtime of every
 * tracked and untracked file). Any edit between two Stop attempts changes it.
 * `ignore` adds path prefixes to leave out (e.g. harness state for test caching).
 */
export async function workspaceFingerprint(
  cwd: string,
  config: ReinsConfig,
  ignore: readonly string[] = [],
): Promise<string | null> {
  const ignored = [...IGNORED_PREFIXES, ...ignore];
  const head = await runShell("git rev-parse HEAD", { cwd, timeoutMs: 10_000 });
  const listed = await runShell("git ls-files -co --exclude-standard", { cwd, timeoutMs: 30_000 });
  let files: string[];
  if (listed.exitCode === 0) {
    files = listed.stdout.split("\n").filter(Boolean);
  } else {
    files = await filesToScan({ cwd, config, changed: false });
  }
  files = [...new Set(files.map((f) => f.split(path.sep).join("/")))]
    .filter((f) => !ignored.some((p) => f.startsWith(p)))
    .sort()
    .slice(0, 50_000);
  if (files.length === 0) return null;

  const parts: string[] = [head.exitCode === 0 ? head.stdout.trim() : "no-head"];
  for (const rel of files) {
    try {
      const s = await stat(path.join(cwd, rel));
      parts.push(`${rel}:${s.size}:${s.mtimeMs}`);
    } catch {
      parts.push(`${rel}:missing`);
    }
  }
  return sha256(parts.join("\n"));
}

/**
 * Repeat guard. Call only when Stop is about to block. Returns true when this
 * block is the (N+1)th identical one in a row with an unchanged tree, i.e. the
 * hook should stop blocking.
 */
export function registerStopBlock(
  state: SessionState,
  fingerprint: string,
  workspace: string | null,
  maxRepeatBlocks: number,
  slot: "stopBlocks" | "subagentBlocks" = "stopBlocks",
): { gaveUp: boolean; count: number } {
  const prev = state[slot] ?? null;
  const same = prev != null && prev.fingerprint === fingerprint && prev.workspace === workspace;
  if (same && maxRepeatBlocks > 0 && prev.count >= maxRepeatBlocks) {
    return { gaveUp: true, count: prev.count };
  }
  const count = same ? prev.count + 1 : 1;
  state[slot] = { fingerprint, workspace, count };
  return { gaveUp: false, count };
}
