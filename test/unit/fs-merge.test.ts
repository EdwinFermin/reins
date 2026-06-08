import { describe, expect, it } from "vitest";
import { deepMergeSettings, mergeStringList } from "../../src/core/fs/merge";
import { hasManagedBlock, upsertManagedBlock } from "../../src/core/fs/markers";

describe("deepMergeSettings", () => {
  it("unions permissions, dedupes hooks, and preserves user keys", () => {
    const existing = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user" }] }] },
      permissions: { allow: ["Bash(ls)"] },
      custom: true,
    };
    const incoming = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "npx reins verify" }] }],
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "npx reins verify --changed" }],
          },
        ],
      },
      permissions: { allow: ["Bash(npx reins:*)", "Bash(ls)"] },
    };

    const merged = deepMergeSettings(existing, incoming);
    expect(merged.custom).toBe(true);
    expect(merged.permissions.allow).toEqual(["Bash(ls)", "Bash(npx reins:*)"]);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.PostToolUse).toHaveLength(1);

    // Idempotent: merging again changes nothing.
    const again = deepMergeSettings(merged, incoming);
    expect(again).toEqual(merged);
  });
});

describe("mergeStringList", () => {
  it("appends only missing items", () => {
    expect(mergeStringList(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("upsertManagedBlock", () => {
  it("appends when absent and replaces in place when present", () => {
    const first = upsertManagedBlock("node_modules\n", ".reins-backup");
    expect(hasManagedBlock(first)).toBe(true);
    expect(first).toContain("node_modules");

    const second = upsertManagedBlock(first, ".reins-backup\ndist");
    expect(second).toContain("dist");
    // Replacing keeps a single managed block.
    expect(second.match(/>>> reins >>>/g)).toHaveLength(1);

    // Re-applying identical body is a no-op.
    expect(upsertManagedBlock(second, ".reins-backup\ndist")).toBe(second);
  });
});
