import type { DoctorReport } from "./runner";

function icon(status: string): string {
  return status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗";
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["", "Reins doctor"];
  for (const r of report.results) {
    lines.push(`  ${icon(r.status)} ${r.id.padEnd(18)} ${r.summary}`);
  }
  lines.push("");
  if (!report.installed) {
    lines.push("Result: NOT INSTALLED — run `reins init`.");
  } else if (report.ok) {
    lines.push(
      report.updateAvailable
        ? "Result: HEALTHY (update available — run `reins update`)"
        : "Result: HEALTHY",
    );
  } else {
    lines.push("Result: PROBLEMS FOUND — run `reins doctor --fix` or fix manually.");
  }
  lines.push("");
  return lines.join("\n");
}
