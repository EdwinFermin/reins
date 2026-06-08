import type { UpdateAction, UpdateResult } from "./run";

function symbol(action: UpdateAction): string {
  switch (action) {
    case "updated":
    case "added":
    case "merged":
      return "+";
    case "kept-user":
      return "=";
    case "conflict":
      return "!";
    default:
      return " ";
  }
}

export function formatUpdateReport(result: UpdateResult): string {
  if (!result.installed) {
    return "\nReins is not installed here — run `reins init` first.\n";
  }

  const lines: string[] = [
    "",
    `Reins update: v${result.fromVersion} -> v${result.toVersion}${result.applied ? "" : "  (dry run)"}`,
  ];

  const counts: Record<string, number> = {};
  for (const e of result.entries) counts[e.action] = (counts[e.action] ?? 0) + 1;
  lines.push(
    "  " +
      Object.entries(counts)
        .map(([a, n]) => `${n} ${a}`)
        .join(", "),
  );

  for (const e of result.entries) {
    if (e.action === "skip") continue;
    lines.push(`  ${symbol(e.action)} ${e.path}${e.note ? ` — ${e.note}` : ""}`);
  }

  lines.push("");
  if (!result.applied) {
    lines.push("Nothing was written. Re-run with `--yes` to apply.");
  } else if (result.conflicts.length > 0) {
    lines.push(
      `${result.conflicts.length} conflict(s) need attention — resolve them, or re-run with \`--yes --force\`.`,
    );
  } else {
    lines.push("Update applied.");
  }
  lines.push("");
  return lines.join("\n");
}
