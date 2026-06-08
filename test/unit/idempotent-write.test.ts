import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyFile } from "../../src/core/fs/idempotent-write";

async function tmpProject(): Promise<{ cwd: string; backupRoot: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-iw-"));
  return { cwd, backupRoot: path.join(cwd, ".reins-backup", "run") };
}

describe("applyFile — plain files", () => {
  it("creates, skips identical, and backs up before overwriting", async () => {
    const { cwd, backupRoot } = await tmpProject();
    const file = { templateId: "doc", destRel: "docs/a.md", content: "hello\n" } as const;

    expect((await applyFile(file, { cwd, backupRoot })).action).toBe("create");
    expect(await readFile(path.join(cwd, "docs/a.md"), "utf8")).toBe("hello\n");

    expect((await applyFile(file, { cwd, backupRoot })).action).toBe("skip");

    const changed = { ...file, content: "changed\n" };
    expect((await applyFile(changed, { cwd, backupRoot })).action).toBe("backup-overwrite");
    expect(await readFile(path.join(cwd, "docs/a.md"), "utf8")).toBe("changed\n");
    await expect(stat(path.join(backupRoot, "docs/a.md"))).resolves.toBeDefined();
  });
});

describe("applyFile — settings.json", () => {
  it("merges into an existing settings file and is idempotent", async () => {
    const { cwd, backupRoot } = await tmpProject();
    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    await writeFile(
      path.join(cwd, ".claude/settings.json"),
      JSON.stringify(
        {
          hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user" }] }] },
          permissions: { allow: ["Bash(ls)"] },
          custom: 1,
        },
        null,
        2,
      ) + "\n",
    );
    const incoming = {
      templateId: "settings",
      destRel: ".claude/settings.json",
      kind: "settings-json" as const,
      content: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "npx reins verify --hook Stop" }] }],
        },
        permissions: { allow: ["Bash(npx reins:*)"] },
      }),
    };

    expect((await applyFile(incoming, { cwd, backupRoot })).action).toBe("merge");
    const merged = JSON.parse(await readFile(path.join(cwd, ".claude/settings.json"), "utf8"));
    expect(merged.custom).toBe(1);
    expect(merged.permissions.allow).toEqual(["Bash(ls)", "Bash(npx reins:*)"]);
    expect(merged.hooks.Stop).toHaveLength(2);

    expect((await applyFile(incoming, { cwd, backupRoot })).action).toBe("skip");
  });
});

describe("applyFile — gitignore", () => {
  it("creates a managed block then skips on re-apply", async () => {
    const { cwd, backupRoot } = await tmpProject();
    const file = {
      templateId: "gitignore",
      destRel: ".gitignore",
      kind: "gitignore" as const,
      content: ".reins-backup\n",
    };
    expect((await applyFile(file, { cwd, backupRoot })).action).toBe("create");
    const text = await readFile(path.join(cwd, ".gitignore"), "utf8");
    expect(text).toContain(">>> reins >>>");
    expect(text).toContain(".reins-backup");
    expect((await applyFile(file, { cwd, backupRoot })).action).toBe("skip");
  });
});

describe("applyFile — claude-md", () => {
  it("creates a wrapped block, and sidecars when an unmanaged CLAUDE.md exists", async () => {
    const { cwd, backupRoot } = await tmpProject();
    const file = {
      templateId: "claude",
      destRel: "CLAUDE.md",
      kind: "claude-md" as const,
      content: "Act as the leader.\n",
    };
    // Fresh create -> wrapped managed block, idempotent.
    expect((await applyFile(file, { cwd, backupRoot })).action).toBe("create");
    expect((await applyFile(file, { cwd, backupRoot })).action).toBe("skip");

    // Pre-existing unmanaged CLAUDE.md -> sidecar.
    const { cwd: cwd2, backupRoot: backupRoot2 } = await tmpProject();
    await writeFile(path.join(cwd2, "CLAUDE.md"), "# My project rules\n");
    const out = await applyFile(file, { cwd: cwd2, backupRoot: backupRoot2 });
    expect(out.action).toBe("sidecar");
    expect(out.destRel).toBe("CLAUDE.reins.md");
    expect(await readFile(path.join(cwd2, "CLAUDE.md"), "utf8")).toBe("# My project rules\n");
  });
});
