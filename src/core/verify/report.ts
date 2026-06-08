import type { VerifyReport } from "./runner";

function icon(status: string): string {
  return status === "pass" ? "✓" : status === "fail" ? "✗" : "∘";
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function formatReport(
  report: VerifyReport,
  opts: { hook?: string; quiet?: boolean } = {},
): string {
  const lines: string[] = ["", `Reins verify${opts.hook ? ` (${opts.hook})` : ""}`];

  for (const r of report.results) {
    const dur = r.durationMs ? `  ${fmtMs(r.durationMs)}` : "";
    lines.push(`  ${icon(r.status)} ${r.id.padEnd(13)} ${r.summary}${dur}`);
    if (r.status === "fail" && r.details && !opts.quiet) {
      for (const detail of r.details.split("\n").slice(0, 6)) {
        lines.push(`      ${detail}`);
      }
    }
  }

  lines.push("");
  if (report.ok) {
    lines.push("Result: PASS");
  } else {
    lines.push(
      `Result: FAIL — required check(s) failed: ${report.requiredFailed.map((r) => r.id).join(", ")}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
