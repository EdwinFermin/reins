import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasBinary, runShell } from "../exec/run-command";
import {
  auditCommand,
  evaluateAudit,
  parseAuditOutput,
  resolveAuditTool,
  severityLabel,
  type AuditEvaluation,
} from "./audit";
import { lockfileHash } from "./lockfile";
import { filesToScan, looksBinary } from "./scan-files";
import { fail, pass, skip, type CheckContext, type CheckResult, type SubResult } from "./types";

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

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** e.g. " (52 ignored via 3 allowlisted advisories, earliest expiry 2026-11-05)". */
function ignoredSuffix(ev: AuditEvaluation): string {
  if (ev.ignoredCount === 0) return "";
  const earliest = ev.matchedIgnores.map((e) => e.until).sort()[0];
  return (
    ` (${ev.ignoredCount} ignored via ` +
    `${plural(ev.matchedIgnores.length, "allowlisted advisory", "allowlisted advisories")}` +
    `${earliest ? `, earliest expiry ${earliest}` : ""})`
  );
}

function auditDetails(ev: AuditEvaluation): string | undefined {
  const lines: string[] = [];
  for (const e of ev.expired) {
    lines.push(`ignore for ${e.id} expired on ${e.until}, re-evaluate (reason was: ${e.reason})`);
  }
  for (const a of ev.blockingAdvisories.slice(0, 10)) {
    const affected = ev.blocking.filter((b) => b.advisories.some((x) => x.key === a.key)).length;
    const extra = affected > 1 ? ` (affects ${affected} packages)` : "";
    lines.push(
      `${a.key}  ${severityLabel(a.severity)}  ${a.package ?? "?"}${a.title ? ` — ${a.title}` : ""}${extra}`,
    );
  }
  if (ev.blockingAdvisories.length > 10)
    lines.push(`… and ${ev.blockingAdvisories.length - 10} more advisory(ies)`);
  for (const e of ev.unusedIgnores) {
    lines.push(`allowlist entry ${e.id} matched no finding — remove it if the fix has landed`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

async function depsAudit(ctx: CheckContext): Promise<SubResult> {
  const cfg = ctx.config.security.depsAudit;
  if (!cfg.enabled) return sub("skip", "deps audit disabled");

  const now = ctx.now ?? new Date();
  const start = Date.now();
  // Expiry is a config fact, so it fails even when the audit itself can't run.
  const expiredOnly = evaluateAudit([], { failOn: cfg.failOn, ignore: cfg.ignore, now });
  const skipOrExpired = (summary: string, ms = 0): SubResult =>
    expiredOnly.expired.length
      ? sub("fail", expiryMessage(expiredOnly), ms, auditDetails(expiredOnly))
      : sub("skip", summary, ms);

  const tool = resolveAuditTool(ctx.config);
  if (!tool)
    return skipOrExpired(`no dependency audit configured for ${ctx.config.stack.language}`);

  const command = await auditCommand(tool, ctx.cwd);
  if ("unavailable" in command) return skipOrExpired(command.unavailable, Date.now() - start);

  const res = await runShell(command.cmd, { cwd: ctx.cwd, timeoutMs: 60_000 });
  const entries = parseAuditOutput(tool, res.stdout);
  const ms = Date.now() - start;
  if (!entries) {
    return skipOrExpired(
      tool === "npm" || tool === "pnpm" || tool === "yarn"
        ? "audit unavailable (offline or no lockfile)"
        : `${tool} output not parseable`,
      ms,
    );
  }

  const ev = evaluateAudit(entries, { failOn: cfg.failOn, ignore: cfg.ignore, now });
  const result: SubResult = {
    status: "pass",
    summary: "",
    durationMs: ms,
    details: auditDetails(ev),
    deps: {
      tool,
      lockfileHash: await lockfileHash(ctx.cwd),
      blockingAdvisories: ev.blockingAdvisories.map((a) => a.key),
      expired: ev.expired.map((e) => e.id),
    },
  };

  if (ev.expired.length) {
    result.status = "fail";
    result.summary = expiryMessage(ev);
  } else if (ev.blocking.length > 0) {
    result.status = "fail";
    result.summary =
      `${ev.blocking.length} dependency vulnerability(ies) >= ${cfg.failOn}` + ignoredSuffix(ev);
  } else {
    result.summary = `no vulnerabilities >= ${cfg.failOn}` + ignoredSuffix(ev);
  }
  return result;
}

function expiryMessage(ev: AuditEvaluation): string {
  const [first, ...rest] = ev.expired;
  if (!first) return "";
  const more = rest.length ? ` (+${rest.length} more expired)` : "";
  return `ignore for ${first.id} expired on ${first.until}, re-evaluate${more}`;
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

  const meta = {
    deps: deps.deps ?? null,
    depsFailed: deps.status === "fail",
    secretsFailed: secrets.status === "fail",
  };

  let result: CheckResult;
  if (deps.status === "fail" || secrets.status === "fail") {
    result = fail("security", summary, durationMs, details);
  } else if (deps.status === "skip" && secrets.status === "skip") {
    result = skip("security", summary, durationMs);
  } else {
    result = pass("security", summary, durationMs, details);
  }
  return { ...result, security: meta };
}
