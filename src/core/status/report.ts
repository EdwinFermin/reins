import type { StatusReport } from "./run";

export function formatStatus(s: StatusReport): string {
  if (!s.installed) {
    return "\nReins is not installed here — run `reins init`.\n";
  }

  const lines: string[] = ["", `Reins status — ${s.preset} harness v${s.harnessVersion}`];

  lines.push(
    `  Active:    ${
      s.active
        ? `${s.active.slug}${s.active.title ? ` (${s.active.title})` : ""} [${s.active.lane}]`
        : "none"
    }`,
  );

  const countStr =
    Object.entries(s.counts)
      .map(([state, n]) => `${n} ${state}`)
      .join(", ") || "no features yet";
  lines.push(`  Features:  ${s.total} total — ${countStr}`);

  if (s.queue.length > 0) {
    lines.push(`  Queue:     ${s.queue.map((q) => `${q.slug} [${q.lane}]`).join(", ")}`);
  }

  lines.push(
    `  Telemetry: ${
      s.telemetry
        ? `${s.telemetry.subagents} subagent run(s), ${(s.telemetry.durationMs / 60_000).toFixed(1)} min, ~$${s.telemetry.costUsd.toFixed(2)} this session — \`reins telemetry report\` for the breakdown`
        : "none yet"
    }`,
  );
  lines.push("");
  return lines.join("\n");
}
