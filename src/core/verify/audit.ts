import type { AuditIgnore, AuditSeverity, AuditTool, ReinsConfig } from "../config/schema";
import { hasBinary, runShell } from "../exec/run-command";

/**
 * Tool-agnostic dependency audit model.
 *
 * Every supported auditor (npm, pnpm, yarn classic/berry, pip-audit,
 * cargo-audit, govulncheck) is normalized into `AuditEntry`s — one per thing
 * the tool counts as a finding — each carrying the *root* advisories that
 * cause it. The allowlist then works on advisory IDs alone, so it behaves the
 * same for every ecosystem.
 */

export type Severity = "info" | AuditSeverity;

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

/** A root advisory. `ids` holds every identifier the tool reported for it. */
export interface Advisory {
  /** Stable identity: the GHSA ID when known, else the tool's primary ID. */
  key: string;
  ids: string[];
  /** null = the tool reports no severity (pip-audit, cargo-audit, govulncheck). */
  severity: Severity | null;
  package?: string;
  title?: string;
}

/** One reported finding (an npm vulnerable package, a pip-audit vuln, …). */
export interface AuditEntry {
  package: string;
  /** The tool's own severity for the entry, when it has one. */
  severity: Severity | null;
  /** Root causes. For npm this follows the `via` chain to the real advisories. */
  advisories: Advisory[];
}

const GHSA_RE = /GHSA(?:-[0-9a-z]{4}){3}/i;
const CVE_RE = /CVE-\d{4}-\d{4,}/i;

function normalizeSeverity(value: unknown): Severity | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "medium") return "moderate";
  if (v === "info" || v === "low" || v === "moderate" || v === "high" || v === "critical") return v;
  return null;
}

/** Unknown severity ranks above everything: a finding we can't grade always counts. */
function rank(severity: Severity | null): number {
  return severity == null ? Number.POSITIVE_INFINITY : SEVERITY_RANK[severity];
}

function maxSeverity(list: (Severity | null)[]): Severity | null {
  let best: Severity | null = "info";
  for (const s of list) if (rank(s) > rank(best)) best = s;
  return best;
}

function uniq(ids: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed && !out.some((o) => o.toUpperCase() === trimmed.toUpperCase())) out.push(trimmed);
  }
  return out;
}

function makeAdvisory(
  ids: string[],
  severity: Severity | null,
  extra: { package?: string; title?: string } = {},
): Advisory | null {
  if (ids.length === 0) return null;
  const ghsa = ids.find((id) => GHSA_RE.test(id) && id.toUpperCase().startsWith("GHSA"));
  return { key: ghsa ?? ids[0]!, ids, severity, ...extra };
}

function idsFromText(...texts: unknown[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    if (typeof t !== "string") continue;
    const g = t.match(GHSA_RE);
    if (g) out.push(g[0]);
    const c = t.match(CVE_RE);
    if (c) out.push(c[0].toUpperCase());
  }
  return out;
}

/**
 * Split a stream of concatenated JSON values (NDJSON, or govulncheck's
 * pretty-printed object stream) into parsed objects. Malformed chunks are skipped.
 */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = depth > 0;
    else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if ((ch === "}" || ch === "]") && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // skip
        }
        start = -1;
      }
    }
  }
  return out;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** npm 7+ (`vulnerabilities` keyed by package, with a `via` chain). */
function parseNpmV2(vulns: Json): AuditEntry[] {
  const memo = new Map<string, Advisory[]>();

  const rootsOf = (name: string, stack: Set<string>): Advisory[] => {
    const cached = memo.get(name);
    if (cached) return cached;
    if (stack.has(name)) return []; // defensive: break a cyclic via chain
    stack.add(name);
    const found = new Map<string, Advisory>();
    const entry = vulns[name];
    const via = isObj(entry) && Array.isArray(entry.via) ? entry.via : [];
    for (const v of via) {
      if (typeof v === "string") {
        for (const a of rootsOf(v, stack)) found.set(a.key, a);
      } else if (isObj(v)) {
        const ids = uniq([
          ...idsFromText(v.url, v.title),
          typeof v.source === "number" || typeof v.source === "string" ? String(v.source) : null,
        ]);
        const adv = makeAdvisory(ids, normalizeSeverity(v.severity), {
          package: typeof v.name === "string" ? v.name : name,
          title: typeof v.title === "string" ? v.title : undefined,
        });
        if (adv) found.set(adv.key, adv);
      }
    }
    stack.delete(name);
    const list = [...found.values()];
    memo.set(name, list);
    return list;
  };

  return Object.entries(vulns).map(([name, v]) => ({
    package: isObj(v) && typeof v.name === "string" ? v.name : name,
    severity: isObj(v) ? normalizeSeverity(v.severity) : null,
    advisories: rootsOf(name, new Set()),
  }));
}

/** npm 6 / pnpm / yarn-berry v3 shape: one advisory object per finding. */
function legacyAdvisoryEntry(a: Json): AuditEntry | null {
  const ids = uniq([
    typeof a.github_advisory_id === "string" ? a.github_advisory_id : null,
    ...(Array.isArray(a.cves) ? (a.cves as unknown[]).map(String) : []),
    ...idsFromText(a.url),
    a.id != null ? String(a.id) : null,
  ]);
  const severity = normalizeSeverity(a.severity);
  const pkg = typeof a.module_name === "string" ? a.module_name : "?";
  const adv = makeAdvisory(ids, severity, {
    package: pkg,
    title: typeof a.title === "string" ? a.title : undefined,
  });
  return adv ? { package: pkg, severity, advisories: [adv] } : null;
}

function dedupeEntries(entries: AuditEntry[]): AuditEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const k = `${e.package}\0${e.advisories.map((a) => a.key).join(",")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** npm / pnpm / yarn (classic NDJSON or berry) output. */
function parseNodeAudit(stdout: string): AuditEntry[] | null {
  let whole: unknown = null;
  try {
    whole = JSON.parse(stdout);
  } catch {
    whole = null;
  }

  if (isObj(whole)) {
    if (whole.error != null && whole.vulnerabilities == null && whole.advisories == null)
      return null;
    if (isObj(whole.vulnerabilities)) return parseNpmV2(whole.vulnerabilities);
    if (isObj(whole.advisories)) {
      return Object.values(whole.advisories)
        .filter(isObj)
        .map(legacyAdvisoryEntry)
        .filter((e): e is AuditEntry => e != null);
    }
    if (isObj(whole.metadata)) return []; // summary only, nothing reported
  }

  // Streams: yarn classic (`{type:"auditAdvisory"}`) or yarn berry v4 (`{value, children}`).
  const entries: AuditEntry[] = [];
  let recognized = false;
  for (const obj of parseJsonStream(stdout)) {
    if (!isObj(obj)) continue;
    if (obj.type === "auditSummary") recognized = true;
    if (obj.type === "auditAdvisory" && isObj(obj.data) && isObj(obj.data.advisory)) {
      recognized = true;
      const e = legacyAdvisoryEntry(obj.data.advisory);
      if (e) entries.push(e);
    } else if (typeof obj.value === "string" && isObj(obj.children)) {
      recognized = true;
      const c = obj.children;
      const severity = normalizeSeverity(c.Severity);
      const ids = uniq([...idsFromText(c.URL, c.Issue), c.ID != null ? String(c.ID) : null]);
      const adv = makeAdvisory(ids, severity, {
        package: obj.value,
        title: typeof c.Issue === "string" ? c.Issue : undefined,
      });
      if (adv) entries.push({ package: obj.value, severity, advisories: [adv] });
    }
  }
  return recognized ? dedupeEntries(entries) : null;
}

/** pip-audit `--format json`: `{dependencies:[{name, vulns:[{id, aliases}]}]}` (or a bare array). */
function parsePipAudit(stdout: string): AuditEntry[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const deps = Array.isArray(data) ? data : isObj(data) ? data.dependencies : null;
  if (!Array.isArray(deps)) return null;
  const entries: AuditEntry[] = [];
  for (const dep of deps) {
    if (!isObj(dep) || !Array.isArray(dep.vulns)) continue;
    const pkg = typeof dep.name === "string" ? dep.name : "?";
    for (const v of dep.vulns) {
      if (!isObj(v)) continue;
      const ids = uniq([
        typeof v.id === "string" ? v.id : null,
        ...(Array.isArray(v.aliases) ? (v.aliases as unknown[]).map(String) : []),
      ]);
      const adv = makeAdvisory(ids, null, { package: pkg });
      if (adv) entries.push({ package: pkg, severity: null, advisories: [adv] });
    }
  }
  return entries;
}

/** cargo-audit `--json`: `{vulnerabilities:{list:[{advisory:{id, aliases}, package:{name}}]}}`. */
function parseCargoAudit(stdout: string): AuditEntry[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isObj(data) || !isObj(data.vulnerabilities)) return null;
  const list = Array.isArray(data.vulnerabilities.list) ? data.vulnerabilities.list : [];
  const entries: AuditEntry[] = [];
  for (const item of list) {
    if (!isObj(item) || !isObj(item.advisory)) continue;
    const a = item.advisory;
    const pkg =
      isObj(item.package) && typeof item.package.name === "string"
        ? item.package.name
        : typeof a.package === "string"
          ? a.package
          : "?";
    const ids = uniq([
      typeof a.id === "string" ? a.id : null,
      ...(Array.isArray(a.aliases) ? (a.aliases as unknown[]).map(String) : []),
    ]);
    const adv = makeAdvisory(ids, null, {
      package: pkg,
      title: typeof a.title === "string" ? a.title : undefined,
    });
    if (adv) entries.push({ package: pkg, severity: null, advisories: [adv] });
  }
  return entries;
}

/**
 * govulncheck `-json`: a stream of `{osv}` and `{finding}` messages. Only
 * vulnerabilities whose vulnerable symbol is actually called (a trace frame
 * with a `function`) count — the same set govulncheck itself reports.
 */
function parseGovulncheck(stdout: string): AuditEntry[] | null {
  const messages = parseJsonStream(stdout).filter(isObj);
  if (messages.length === 0) return null;
  const osvs = new Map<string, Json>();
  const called = new Set<string>();
  for (const m of messages) {
    if (isObj(m.osv) && typeof m.osv.id === "string") osvs.set(m.osv.id, m.osv);
    if (isObj(m.finding) && typeof m.finding.osv === "string") {
      const trace = Array.isArray(m.finding.trace) ? m.finding.trace : [];
      if (trace.some((f) => isObj(f) && typeof f.function === "string" && f.function))
        called.add(m.finding.osv);
    }
  }
  const entries: AuditEntry[] = [];
  for (const id of called) {
    const osv = osvs.get(id);
    const affected = osv && Array.isArray(osv.affected) ? osv.affected : [];
    const first = affected.find(isObj);
    const pkg =
      first && isObj(first.package) && typeof first.package.name === "string"
        ? first.package.name
        : "?";
    const ids = uniq([
      id,
      ...(osv && Array.isArray(osv.aliases) ? (osv.aliases as unknown[]).map(String) : []),
    ]);
    const adv = makeAdvisory(ids, null, {
      package: pkg,
      title: osv && typeof osv.summary === "string" ? osv.summary : undefined,
    });
    if (adv) entries.push({ package: pkg, severity: null, advisories: [adv] });
  }
  return entries;
}

/** Parse an auditor's JSON output. Returns null when it is not recognizable. */
export function parseAuditOutput(tool: Exclude<AuditTool, "auto">, stdout: string) {
  switch (tool) {
    case "npm":
    case "pnpm":
    case "yarn":
      return parseNodeAudit(stdout);
    case "pip-audit":
      return parsePipAudit(stdout);
    case "cargo-audit":
      return parseCargoAudit(stdout);
    case "govulncheck":
      return parseGovulncheck(stdout);
  }
}

/** The auditor `tool: "auto"` (or an explicit tool) resolves to, or null when none applies. */
export function resolveAuditTool(config: ReinsConfig): Exclude<AuditTool, "auto"> | null {
  const tool = config.security.depsAudit.tool;
  if (tool !== "auto") return tool;
  const { language, packageManager } = config.stack;
  switch (language) {
    case "node":
      return packageManager === "pnpm" || packageManager === "yarn" ? packageManager : "npm";
    case "python":
      return "pip-audit";
    case "rust":
      return "cargo-audit";
    case "go":
      return "govulncheck";
    default:
      return null;
  }
}

/** Resolve the shell command for a tool, or a reason it can't run here. */
export async function auditCommand(
  tool: Exclude<AuditTool, "auto">,
  cwd: string,
): Promise<{ cmd: string } | { unavailable: string }> {
  switch (tool) {
    case "npm":
      return { cmd: "npm audit --json" };
    case "pnpm":
      return { cmd: "pnpm audit --json" };
    case "yarn": {
      const v = await runShell("yarn --version", { cwd, timeoutMs: 10_000 });
      if (v.exitCode !== 0) return { unavailable: "yarn not installed" };
      return v.stdout.trim().startsWith("1.")
        ? { cmd: "yarn audit --json" }
        : { cmd: "yarn npm audit --json --recursive" };
    }
    case "pip-audit":
      return (await hasBinary("pip-audit"))
        ? { cmd: "pip-audit --format json" }
        : { unavailable: "pip-audit not installed" };
    case "cargo-audit":
      return (await hasBinary("cargo-audit"))
        ? { cmd: "cargo audit --json" }
        : { unavailable: "cargo-audit not installed" };
    case "govulncheck":
      return (await hasBinary("govulncheck"))
        ? { cmd: "govulncheck -json ./..." }
        : { unavailable: "govulncheck not installed" };
  }
}

// ---------------------------------------------------------------------------
// Allowlist evaluation
// ---------------------------------------------------------------------------

/** Local calendar date as YYYY-MM-DD (allowlist `until` is inclusive of that day). */
export function localIsoDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isExpired(entry: AuditIgnore, now: Date): boolean {
  return localIsoDate(now) > entry.until;
}

function matches(entry: AuditIgnore, adv: Advisory): boolean {
  const want = entry.id.toUpperCase();
  return adv.ids.some((id) => id.toUpperCase() === want);
}

export interface AuditEvaluation {
  /** Entries still at/above `failOn` after the allowlist. */
  blocking: AuditEntry[];
  /** Non-allowlisted root advisories that make `blocking` entries block. */
  blockingAdvisories: Advisory[];
  /** Entries that were at/above `failOn` but are fully covered by the allowlist. */
  ignoredCount: number;
  /** Active allowlist entries that suppressed at least one at/above-threshold entry. */
  matchedIgnores: AuditIgnore[];
  /** Active allowlist entries that matched nothing in this audit (candidates for removal). */
  unusedIgnores: AuditIgnore[];
  /** Allowlist entries past their `until` date (they no longer apply). */
  expired: AuditIgnore[];
}

/** Apply `failOn` + the allowlist to normalized audit entries. */
export function evaluateAudit(
  entries: AuditEntry[],
  opts: { failOn: AuditSeverity; ignore: AuditIgnore[]; now: Date },
): AuditEvaluation {
  const threshold = SEVERITY_RANK[opts.failOn];
  const expired = opts.ignore.filter((e) => isExpired(e, opts.now));
  const active = opts.ignore.filter((e) => !isExpired(e, opts.now));

  const blocking: AuditEntry[] = [];
  const blockingAdvisories = new Map<string, Advisory>();
  const matched = new Set<AuditIgnore>();
  const touched = new Set<AuditIgnore>();
  let ignoredCount = 0;

  for (const entry of entries) {
    const original = entry.severity ?? maxSeverity(entry.advisories.map((a) => a.severity));
    const remaining: Advisory[] = [];
    const suppressedBy: AuditIgnore[] = [];
    for (const adv of entry.advisories) {
      const hit = active.find((ig) => matches(ig, adv));
      if (hit) {
        suppressedBy.push(hit);
        touched.add(hit);
      } else remaining.push(adv);
    }

    // With nothing suppressed, trust the tool's own grading; otherwise the
    // entry is only as severe as its remaining (non-allowlisted) root causes.
    const effective =
      suppressedBy.length === 0 ? original : maxSeverity(remaining.map((a) => a.severity));
    const wasBlocking = rank(original) >= threshold;
    const isBlocking = remaining.length > 0 && rank(effective) >= threshold;
    // An entry with no resolvable advisories can't be allowlisted.
    const stillBlocking = entry.advisories.length === 0 ? wasBlocking : isBlocking;

    if (stillBlocking) {
      blocking.push(entry);
      const causes = remaining.filter((a) => rank(a.severity) >= threshold);
      for (const a of causes.length ? causes : remaining) blockingAdvisories.set(a.key, a);
      if (entry.advisories.length === 0) {
        const key = `pkg:${entry.package}`;
        blockingAdvisories.set(key, {
          key,
          ids: [key],
          severity: original,
          package: entry.package,
        });
      }
    } else if (wasBlocking && suppressedBy.length > 0) {
      ignoredCount++;
      for (const ig of suppressedBy) matched.add(ig);
    }
  }

  return {
    blocking,
    blockingAdvisories: [...blockingAdvisories.values()].sort((a, b) => a.key.localeCompare(b.key)),
    ignoredCount,
    matchedIgnores: active.filter((e) => matched.has(e)),
    unusedIgnores: active.filter((e) => !touched.has(e)),
    expired,
  };
}

export function severityLabel(s: Severity | null): string {
  return s ?? "unrated";
}
