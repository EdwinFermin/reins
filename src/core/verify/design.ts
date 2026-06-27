import { readFile } from "node:fs/promises";
import path from "node:path";
import { filesToScan, looksBinary } from "./scan-files";
import { fail, pass, skip, type CheckContext, type CheckResult } from "./types";

type Severity = "advisory" | "block";

const SEVERITY_RANK: Record<Severity, number> = { advisory: 1, block: 2 };

interface SlopRule {
  rule: string;
  severity: Severity;
  /** Return true when this line trips the rule. */
  test: (line: string) => boolean;
  /**
   * When set, the rule is a "too much of a good thing" tell: it fires once for the
   * whole scan only if it hit at least `threshold` times (e.g. hover-scale on
   * everything). Without a threshold, every hit is a finding.
   */
  threshold?: number;
}

/**
 * Files whose content is user-facing UI. Deliberately narrow — scanning every
 * `.ts`/`.js` would bury real tells under false positives from backend code.
 */
const UI_EXT = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".vue",
  ".svelte",
  ".astro",
  ".jsx",
  ".tsx",
  ".mdx",
]);

/**
 * The deterministic floor of `docs/design.md` — a high-precision subset of the
 * "Slop tells" blocklist that a regex can catch reliably. The rest (hierarchy,
 * contrast, design-system fidelity) is the `design-reviewer`'s judgment, not this.
 */
const RULES: SlopRule[] = [
  // — Block: shipping these to a user is almost never intentional —
  {
    rule: "placeholder content (Lorem ipsum)",
    severity: "block",
    test: (l) => /lorem ipsum/i.test(l),
  },
  {
    rule: "gradient text (bg-clip-text + text-transparent)",
    severity: "block",
    test: (l) => /\bbg-clip-text\b/.test(l) && /\btext-transparent\b/.test(l),
  },
  // — Advisory: strong AI-slop tells, but occasionally a deliberate choice —
  {
    rule: "generic AI gradient palette (indigo/violet/purple → pink/cyan)",
    severity: "advisory",
    test: (l) =>
      /\bfrom-(?:indigo|violet|purple|fuchsia)-\d{2,3}\b/.test(l) &&
      /\b(?:via|to)-(?:violet|purple|fuchsia|pink|rose|cyan|sky|blue)-\d{2,3}\b/.test(l),
  },
  {
    rule: "default glassmorphism (backdrop-blur on a translucent surface)",
    severity: "advisory",
    test: (l) =>
      /\bbackdrop-blur\b/.test(l) &&
      /\bbg-(?:white|black|slate|gray|zinc|neutral|stone)(?:-\d{2,3})?\/\d{1,3}\b/.test(l),
  },
  {
    rule: "hover-scale on everything",
    severity: "advisory",
    threshold: 4,
    test: (l) => /\bhover:scale-\d/.test(l),
  },
  {
    rule: "arbitrary off-scale spacing",
    severity: "advisory",
    threshold: 6,
    test: (l) => /\b(?:p|m|gap|space-[xy]|w|h)[trblxy]?-\[\d+(?:\.\d+)?px\]/.test(l),
  },
];

interface Finding {
  file: string;
  line: number;
  rule: string;
  severity: Severity;
}

function detail(f: Finding): string {
  return `${f.file}:${f.line} — [${f.severity}] ${f.rule}`;
}

/**
 * Static "AI slop" scan of UI files (`docs/design.md`). Skips cleanly when there
 * is no UI to scan, so it is a no-op on backend-only projects and changed-file
 * runs that touch no UI. Severity-driven: a finding at or above `design.slopScan.failOn`
 * fails the check; lower findings are reported but pass.
 */
export async function designCheck(ctx: CheckContext): Promise<CheckResult> {
  const cfg = ctx.config.design.slopScan;
  if (!cfg.enabled) return skip("design", "slop scan disabled");

  const start = Date.now();
  const files = (await filesToScan(ctx)).filter((f) => UI_EXT.has(path.extname(f).toLowerCase()));
  if (files.length === 0) {
    const ms = Date.now() - start;
    return skip("design", ctx.changed ? "no UI files changed" : "no UI files to scan", ms);
  }

  const findings: Finding[] = [];
  const thresholdCounts = new Map<string, number>();
  const thresholdFirst = new Map<string, Finding>();

  for (const rel of files) {
    if (findings.length >= 200) break;
    let text: string;
    try {
      text = await readFile(path.join(ctx.cwd, rel), "utf8");
    } catch {
      continue;
    }
    if (looksBinary(text) || text.length > 1_000_000) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > 5_000) continue;
      for (const r of RULES) {
        if (!r.test(line)) continue;
        if (r.threshold) {
          thresholdCounts.set(r.rule, (thresholdCounts.get(r.rule) ?? 0) + 1);
          if (!thresholdFirst.has(r.rule)) {
            thresholdFirst.set(r.rule, {
              file: rel,
              line: i + 1,
              rule: r.rule,
              severity: r.severity,
            });
          }
        } else {
          findings.push({ file: rel, line: i + 1, rule: r.rule, severity: r.severity });
        }
      }
    }
  }

  // Threshold rules fire once for the whole scan, only if they crossed their bar.
  for (const r of RULES) {
    if (!r.threshold) continue;
    const n = thresholdCounts.get(r.rule) ?? 0;
    if (n >= r.threshold) {
      const first = thresholdFirst.get(r.rule)!;
      findings.push({ ...first, rule: `${r.rule} (${n}×)` });
    }
  }

  const ms = Date.now() - start;
  const failRank = SEVERITY_RANK[cfg.failOn];
  const blocking = findings.filter((f) => SEVERITY_RANK[f.severity] >= failRank);
  const body = findings.slice(0, 10).map(detail).join("\n");

  if (blocking.length > 0) {
    return fail("design", `${blocking.length} slop tell(s) >= ${cfg.failOn}`, ms, body);
  }
  if (findings.length > 0) {
    return pass("design", `${findings.length} advisory slop tell(s)`, ms, body);
  }
  return pass("design", `${files.length} UI file(s) clean`, ms);
}
