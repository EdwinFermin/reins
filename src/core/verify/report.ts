import type { VerifyReport } from "./runner";

function icon(status: string): string {
  if (status === "pass") return "✓";
  if (status === "fail") return "✗";
  if (status === "warn") return "!";
  return "∘";
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
    if ((r.status === "fail" || r.status === "warn") && r.details && !opts.quiet) {
      for (const detail of r.details.split("\n").slice(0, 6)) {
        lines.push(`      ${detail}`);
      }
    }
  }

  if (report.notices.length) {
    lines.push("");
    for (const notice of report.notices) lines.push(`  note: ${notice}`);
  }

  lines.push("");
  const warned = report.results.some((r) => r.status === "warn");
  if (report.ok) {
    lines.push(warned ? "Result: PASS (with warnings)" : "Result: PASS");
  } else {
    const failed = report.requiredFailed.map((r) => r.id).join(", ");
    lines.push(
      report.gaveUp
        ? `Result: FAIL — required check(s) failed: ${failed} (not blocking: repeated identical Stop block)`
        : `Result: FAIL — required check(s) failed: ${failed}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
