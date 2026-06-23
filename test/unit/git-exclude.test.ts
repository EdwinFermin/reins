import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitExcludeEntries, upsertGitExclude } from "../../src/core/fs/git-exclude";

async function tmpRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-ghost-"));
  await mkdir(path.join(cwd, ".git", "info"), { recursive: true });
  return cwd;
}

describe("gitExcludeEntries", () => {
  it("collapses owned dirs, anchors generic paths, and always ignores backups", () => {
    const entries = gitExcludeEntries([
      ".claude/agents/leader.md",
      ".claude/settings.json",
      ".reins/hooks/pre-commit",
      "progress/current.md",
      "specs/_template/tasks.md",
      "docs/architecture.md",
      "CLAUDE.md",
      ".github/workflows/reins-verify.yml",
      "feature_list.json",
    ]);

    // Wholly-owned trees collapse to a single dir rule.
    expect(entries).toContain("/.claude/");
    expect(entries).toContain("/.reins/");
    expect(entries).toContain("/progress/");
    expect(entries).toContain("/specs/");
    // Generic locations the monorepo may also use stay as exact files.
    expect(entries).toContain("/docs/architecture.md");
    expect(entries).not.toContain("/docs/");
    expect(entries).toContain("/.github/workflows/reins-verify.yml");
    expect(entries).not.toContain("/.github/");
    // Root files + the always-on backups rule.
    expect(entries).toContain("/CLAUDE.md");
    expect(entries).toContain("/feature_list.json");
    expect(entries).toContain("/.reins-backup/");
    // Sorted + de-duplicated.
    expect(entries).toEqual([...new Set(entries)].sort());
  });
});

describe("upsertGitExclude", () => {
  it("writes a managed block, is idempotent, and preserves user lines", async () => {
    const cwd = await tmpRepo();
    const excludePath = path.join(cwd, ".git/info/exclude");
    await writeFile(excludePath, "# my own ignore\n*.local\n");

    // The exclude file already exists, so the block is inserted (update), not created.
    const first = await upsertGitExclude(cwd, [".claude/agents/leader.md", "CLAUDE.md"]);
    expect(first.action).toBe("update");
    const text = await readFile(excludePath, "utf8");
    expect(text).toContain("# my own ignore");
    expect(text).toContain("*.local");
    expect(text).toContain(">>> reins >>>");
    expect(text).toContain("/.claude/");
    expect(text).toContain("/CLAUDE.md");

    // Same paths -> no rewrite.
    expect((await upsertGitExclude(cwd, ["CLAUDE.md", ".claude/agents/leader.md"])).action).toBe(
      "skip",
    );

    // New path -> block updated in place, user lines still intact.
    const updated = await upsertGitExclude(cwd, [
      ".claude/agents/leader.md",
      "CLAUDE.md",
      "docs/security.md",
    ]);
    expect(updated.action).toBe("update");
    const after = await readFile(excludePath, "utf8");
    expect(after).toContain("/docs/security.md");
    expect(after).toContain("# my own ignore");
  });

  it("creates .git/info/exclude when absent and respects dryRun", async () => {
    const cwd = await tmpRepo();
    const excludePath = path.join(cwd, ".git/info/exclude");

    const dry = await upsertGitExclude(cwd, ["CLAUDE.md"], { dryRun: true });
    expect(dry.action).toBe("create");
    await expect(readFile(excludePath, "utf8")).rejects.toThrow();

    await upsertGitExclude(cwd, ["CLAUDE.md"]);
    expect(await readFile(excludePath, "utf8")).toContain("/CLAUDE.md");
  });
});
