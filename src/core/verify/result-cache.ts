import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckId, ReinsConfig } from "../config/schema";
import { sha256 } from "../util/hash";
import { workspaceFingerprint } from "./stop-guard";

/**
 * Pass-result cache for the command checks (lint/unit/integration/e2e).
 *
 * One feature used to run the full suite five or more times on the same tree
 * (leader before, implementer, reviewer, leader after, the Stop hook). A pass
 * is now recorded against a fingerprint of the working tree, and a later run
 * on an identical tree reuses it instead of re-running the command.
 *
 * Only passes are cached (a failure always re-runs), only full-scope runs (not
 * `--changed`), and never for the CI hook. Lives in `.reins/cache/`.
 */

export const RESULT_CACHE_REL = path.join(".reins", "cache", "verify-results.json");

/** Checks whose result is a pure function of the tree + command. */
const CACHEABLE = new Set<CheckId>(["lint", "unit", "integration", "e2e"]);

/**
 * Harness state the agents write while working (reports, specs, the queue).
 * Tests don't read it, so it is left out of the test fingerprint — otherwise a
 * reviewer writing its report would invalidate the implementer's green run.
 * Lint keeps it in: a formatter may check those Markdown files.
 */
const TEST_IGNORES = ["progress/", "specs/", "feature_list.json"];

interface CacheEntry {
  fingerprint: string;
  summary: string;
  at: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export interface CacheHit {
  summary: string;
  at: string;
}

export class ResultCache {
  private fingerprints = new Map<string, Promise<string | null>>();

  constructor(
    private readonly cwd: string,
    private readonly config: ReinsConfig,
  ) {}

  static isCacheable(id: CheckId): boolean {
    return CACHEABLE.has(id);
  }

  private fingerprint(id: CheckId): Promise<string | null> {
    const ignore = id === "lint" ? [] : TEST_IGNORES;
    const key = ignore.join(",");
    let fp = this.fingerprints.get(key);
    if (!fp) {
      fp = workspaceFingerprint(this.cwd, this.config, ignore).catch(() => null);
      this.fingerprints.set(key, fp);
    }
    return fp;
  }

  private static key(id: CheckId, command: string): string {
    return sha256(`${id}\u0000${command}`);
  }

  private async load(): Promise<CacheFile> {
    try {
      const data = JSON.parse(
        await readFile(path.join(this.cwd, RESULT_CACHE_REL), "utf8"),
      ) as CacheFile;
      if (data && data.version === 1 && data.entries && typeof data.entries === "object")
        return data;
    } catch {
      // missing or corrupt: start empty
    }
    return { version: 1, entries: {} };
  }

  /**
   * Look up a cached pass for this check + command on the current tree. Returns
   * the fingerprint it compared against, to hand back to `store` after a run.
   */
  async lookup(
    id: CheckId,
    command: string,
  ): Promise<{ hit: CacheHit | null; fingerprint: string | null }> {
    const fp = await this.fingerprint(id);
    if (!fp) return { hit: null, fingerprint: null };
    const entry = (await this.load()).entries[ResultCache.key(id, command)];
    const hit = entry && entry.fingerprint === fp ? { summary: entry.summary, at: entry.at } : null;
    return { hit, fingerprint: fp };
  }

  /**
   * Record a pass against the fingerprint taken before the run — but only when
   * the tree is still identical afterwards. If anything changed while the
   * command ran (an agent editing in parallel, a test writing files), the pass
   * no longer describes one tree, so nothing is cached.
   */
  async store(id: CheckId, command: string, summary: string, before: string | null): Promise<void> {
    if (!before) return;
    this.fingerprints.clear();
    if ((await this.fingerprint(id)) !== before) return;
    try {
      const data = await this.load();
      data.entries[ResultCache.key(id, command)] = {
        fingerprint: before,
        summary,
        at: new Date().toISOString(),
      };
      const abs = path.join(this.cwd, RESULT_CACHE_REL);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, JSON.stringify(data, null, 2) + "\n", "utf8");
    } catch {
      // Best effort: a read-only tree must never break the gate.
    }
  }
}
