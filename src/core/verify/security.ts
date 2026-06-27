import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasBinary, runShell } from "../exec/run-command";
import { filesToScan, looksBinary } from "./scan-files";
import { fail, pass, skip, type CheckContext, type CheckResult, type SubResult } from "./types";

const SEVERITY_ORDER = ["low", "moderate", "high", "critical"] as const;

function sub(
  status: SubResult["status"],
  summary: string,
  durationMs = 0,
  details?: string,
): SubResult {
  return { status, summary, durationMs, details };
}

function tail(text: string, lines = 8): string {
  return text.split("\n").filter(Boolean).slice(-lines).join("\n");
}

function countAtOrAbove(vulns: Record<string, number>, threshold: string): number {
  const idx = SEVERITY_ORDER.indexOf(threshold as (typeof SEVERITY_ORDER)[number]);
  if (idx < 0) return 0;
  let total = 0;
  for (let i = idx; i < SEVERITY_ORDER.length; i++) {
    total += Number(vulns[SEVERITY_ORDER[i]!] ?? 0);
  }
  return total;
}

async function depsAudit(ctx: CheckContext): Promise<SubResult> {
  const cfg = ctx.config.security.depsAudit;
  if (!cfg.enabled) return sub("skip", "deps audit disabled");

  const start = Date.now();
  const { language, packageManager } = ctx.config.stack;

  if (language === "node") {
    const pm = packageManager || "npm";
    const res = await runShell(`${pm} audit --json`, { cwd: ctx.cwd, timeoutMs: 60_000 });
    const ms = Date.now() - start;
    try {
      const data = JSON.parse(res.stdout) as {
        metadata?: { vulnerabilities?: Record<string, number> };
      };
      const vulns = data.metadata?.vulnerabilities;
      if (!vulns) return sub("skip", "audit output had no summary", ms);
      const blocking = countAtOrAbove(vulns, cfg.failOn);
      return blocking > 0
        ? sub("fail", `${blocking} dependency vulnerability(ies) >= ${cfg.failOn}`, ms)
        : sub("pass", `no vulnerabilities >= ${cfg.failOn}`, ms);
    } catch {
      return sub("skip", "audit unavailable (offline or no lockfile)", ms);
    }
  }

  if (language === "python") {
    if (!(await hasBinary("pip-audit"))) return sub("skip", "pip-audit not installed");
    const res = await runShell("pip-audit --format json", { cwd: ctx.cwd, timeoutMs: 60_000 });
    const ms = Date.now() - start;
    try {
      const data = JSON.parse(res.stdout) as { dependencies?: { vulns?: unknown[] }[] };
      const findings = (data.dependencies ?? []).reduce((n, d) => n + (d.vulns?.length ?? 0), 0);
      return findings > 0
        ? sub("fail", `${findings} dependency vulnerability(ies)`, ms)
        : sub("pass", "no known vulnerabilities", ms);
    } catch {
      return sub("skip", "pip-audit output not parseable", ms);
    }
  }

  return sub("skip", `no dependency audit configured for ${language}`);
}

const SECRET_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { rule: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { rule: "GitHub token", re: /gh[pousr]_[0-9A-Za-z]{36,}/ },
  { rule: "Slack token", re: /xox[baprs]-[0-9A-Za-z-]{10,48}/ },
  { rule: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { rule: "Stripe secret key", re: /sk_live_[0-9A-Za-z]{24,}/ },
];

async function secretScan(ctx: CheckContext): Promise<SubResult> {
  const cfg = ctx.config.security.secretScan;
  if (!cfg.enabled) return sub("skip", "secret scan disabled");

  const start = Date.now();
  if (cfg.tool === "gitleaks") {
    if (!(await hasBinary("gitleaks")))
      return sub("skip", "gitleaks not installed", Date.now() - start);
    const res = await runShell("gitleaks detect --no-banner --redact", {
      cwd: ctx.cwd,
      timeoutMs: 60_000,
    });
    const ms = Date.now() - start;
    return res.exitCode === 0
      ? sub("pass", "gitleaks found no leaks", ms)
      : sub("fail", "gitleaks found leaks", ms, tail(res.stdout));
  }

  const files = await filesToScan(ctx);
  const findings: string[] = [];
  for (const rel of files) {
    if (findings.length >= 50) break;
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
      for (const { rule, re } of SECRET_PATTERNS) {
        if (re.test(line)) {
          findings.push(`${rel}:${i + 1} — ${rule}`);
          break;
        }
      }
    }
  }
  const ms = Date.now() - start;
  if (findings.length > 0 && cfg.failOnAny) {
    return sub(
      "fail",
      `${findings.length} potential secret(s)`,
      ms,
      findings.slice(0, 10).join("\n"),
    );
  }
  return sub(
    "pass",
    findings.length ? `${findings.length} low-confidence finding(s)` : "no secrets found",
    ms,
  );
}

/** Composite security check: dependency audit + secret scan. */
export async function securityCheck(ctx: CheckContext): Promise<CheckResult> {
  const [deps, secrets] = await Promise.all([depsAudit(ctx), secretScan(ctx)]);
  const durationMs = deps.durationMs + secrets.durationMs;
  const summary = `deps: ${deps.summary}; secrets: ${secrets.summary}`;
  const details = [deps.details, secrets.details].filter(Boolean).join("\n") || undefined;

  if (deps.status === "fail" || secrets.status === "fail") {
    return fail("security", summary, durationMs, details);
  }
  if (deps.status === "skip" && secrets.status === "skip") {
    return skip("security", summary, durationMs);
  }
  return pass("security", summary, durationMs, details);
}
