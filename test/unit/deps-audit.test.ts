import { describe, expect, it } from "vitest";
import { formatConfigError } from "../../src/core/config/load";
import { ReinsConfigSchema } from "../../src/core/config/schema";
import { depsAllowlistResult } from "../../src/core/doctor/runner";
import {
  evaluateAudit,
  parseAuditOutput,
  parseJsonStream,
  resolveAuditTool,
} from "../../src/core/verify/audit";

const NOW = new Date(2026, 9, 5); // 2026-10-05, local time

const BRACES = "GHSA-vfj7-8cjw-p6xm";
const FORGE = "GHSA-86w9-cpqp-85rv";
const IMAGE_SIZE = "GHSA-w3rx-0000-0000";
const LODASH = "GHSA-aaaa-bbbb-cccc";

function advisory(name: string, ghsa: string, severity: string, source: number) {
  return {
    source,
    name,
    dependency: name,
    title: `${name} advisory`,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range: "<99",
  };
}

/** npm 7+ audit output modelled on the real case: 3 root advisories, a deep via chain. */
function npmAudit(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      braces: { name: "braces", severity: "high", via: [advisory("braces", BRACES, "high", 1)] },
      micromatch: { name: "micromatch", severity: "high", via: ["braces"] },
      anymatch: { name: "anymatch", severity: "high", via: ["micromatch"] },
      chokidar: { name: "chokidar", severity: "high", via: ["anymatch", "braces"] },
      "node-forge": {
        name: "node-forge",
        severity: "high",
        via: [advisory("node-forge", FORGE, "high", 2)],
      },
      "image-size": {
        name: "image-size",
        severity: "high",
        via: [advisory("image-size", IMAGE_SIZE, "high", 3)],
      },
      metro: { name: "metro", severity: "high", via: ["image-size"] },
      ...extra,
    },
    metadata: { vulnerabilities: { high: 7 } },
  });
}

const ignore = (id: string, until = "2026-11-05") => ({ id, reason: "no fix available", until });

describe("parseAuditOutput — npm via chain", () => {
  it("resolves transitive entries to their root advisories", () => {
    const entries = parseAuditOutput("npm", npmAudit())!;
    expect(entries).toHaveLength(7);
    const anymatch = entries.find((e) => e.package === "anymatch")!;
    expect(anymatch.advisories.map((a) => a.key)).toEqual([BRACES]);
    expect(anymatch.advisories[0]!.ids).toContain("1"); // npm advisory number is matchable too
  });

  it("returns null for npm error output (no lockfile / offline)", () => {
    expect(parseAuditOutput("npm", JSON.stringify({ error: { code: "ENOLOCK" } }))).toBeNull();
    expect(parseAuditOutput("npm", "not json")).toBeNull();
  });
});

describe("evaluateAudit — allowlist", () => {
  it("suppresses a root advisory and every finding further down its chain", () => {
    const entries = parseAuditOutput("npm", npmAudit())!;
    const ev = evaluateAudit(entries, {
      failOn: "high",
      ignore: [ignore(BRACES)],
      now: NOW,
    });
    // braces, micromatch, anymatch, chokidar are all braces-only.
    expect(ev.ignoredCount).toBe(4);
    expect(ev.blocking.map((e) => e.package).sort()).toEqual(["image-size", "metro", "node-forge"]);
    expect(ev.blockingAdvisories.map((a) => a.key).sort()).toEqual([FORGE, IMAGE_SIZE].sort());
  });

  it("clears everything when all three roots are allowlisted, and reports the earliest expiry", () => {
    const entries = parseAuditOutput("npm", npmAudit())!;
    const ev = evaluateAudit(entries, {
      failOn: "high",
      ignore: [ignore(BRACES, "2026-11-05"), ignore(FORGE, "2027-01-01"), ignore(IMAGE_SIZE)],
      now: NOW,
    });
    expect(ev.blocking).toHaveLength(0);
    expect(ev.ignoredCount).toBe(7);
    expect(ev.matchedIgnores).toHaveLength(3);
  });

  it("keeps an entry blocking when one of its root causes is not allowlisted", () => {
    const entries = parseAuditOutput(
      "npm",
      npmAudit({
        lodash: { name: "lodash", severity: "high", via: [advisory("lodash", LODASH, "high", 4)] },
        mixed: { name: "mixed", severity: "high", via: ["braces", "lodash"] },
      }),
    )!;
    const ev = evaluateAudit(entries, { failOn: "high", ignore: [ignore(BRACES)], now: NOW });
    expect(ev.blocking.map((e) => e.package)).toContain("mixed");
    expect(ev.blockingAdvisories.map((a) => a.key)).toContain(LODASH);
  });

  it("matches IDs case-insensitively", () => {
    const entries = parseAuditOutput("npm", npmAudit())!;
    const ev = evaluateAudit(entries, {
      failOn: "high",
      ignore: [ignore(BRACES.toLowerCase())],
      now: NOW,
    });
    expect(ev.ignoredCount).toBe(4);
  });

  it("an expired entry stops applying and is reported", () => {
    const entries = parseAuditOutput("npm", npmAudit())!;
    const ev = evaluateAudit(entries, {
      failOn: "high",
      ignore: [ignore(BRACES, "2026-10-04")],
      now: NOW,
    });
    expect(ev.expired.map((e) => e.id)).toEqual([BRACES]);
    expect(ev.ignoredCount).toBe(0);
    expect(ev.blocking).toHaveLength(7);
  });

  it("the until date itself is still valid (inclusive)", () => {
    const ev = evaluateAudit([], {
      failOn: "high",
      ignore: [ignore(BRACES, "2026-10-05")],
      now: NOW,
    });
    expect(ev.expired).toHaveLength(0);
    expect(ev.unusedIgnores.map((e) => e.id)).toEqual([BRACES]);
  });
});

describe("parseAuditOutput — other auditors", () => {
  it("pnpm / npm v6: matches on CVE", () => {
    const out = JSON.stringify({
      advisories: {
        "1001": {
          id: 1001,
          github_advisory_id: "GHSA-1111-2222-3333",
          cves: ["CVE-2024-4067"],
          severity: "high",
          module_name: "micromatch",
          title: "ReDoS",
        },
      },
      metadata: { vulnerabilities: { high: 1 } },
    });
    const entries = parseAuditOutput("pnpm", out)!;
    const ev = evaluateAudit(entries, {
      failOn: "high",
      ignore: [ignore("CVE-2024-4067")],
      now: NOW,
    });
    expect(ev.blocking).toHaveLength(0);
    expect(ev.ignoredCount).toBe(1);
  });

  it("yarn classic NDJSON", () => {
    const line = (id: number, ghsa: string) =>
      JSON.stringify({
        type: "auditAdvisory",
        data: {
          resolution: { path: "a>b" },
          advisory: { id, github_advisory_id: ghsa, severity: "high", module_name: "b", cves: [] },
        },
      });
    const out = [
      line(1, BRACES),
      line(1, BRACES), // same advisory via another path
      line(2, LODASH),
      JSON.stringify({ type: "auditSummary", data: {} }),
    ].join("\n");
    const entries = parseAuditOutput("yarn", out)!;
    expect(entries).toHaveLength(2);
    const ev = evaluateAudit(entries, { failOn: "high", ignore: [ignore(BRACES)], now: NOW });
    expect(ev.blockingAdvisories.map((a) => a.key)).toEqual([LODASH]);
  });

  it("pip-audit: unrated findings always count; aliases are matchable", () => {
    const out = JSON.stringify({
      dependencies: [
        {
          name: "jinja2",
          version: "3.1.2",
          vulns: [{ id: "PYSEC-2024-1", aliases: ["GHSA-h5c8-rqwp-cp95", "CVE-2024-22195"] }],
        },
        { name: "ok", version: "1.0", vulns: [] },
      ],
    });
    const entries = parseAuditOutput("pip-audit", out)!;
    expect(
      evaluateAudit(entries, { failOn: "critical", ignore: [], now: NOW }).blocking,
    ).toHaveLength(1);
    const ev = evaluateAudit(entries, {
      failOn: "critical",
      ignore: [ignore("CVE-2024-22195")],
      now: NOW,
    });
    expect(ev.blocking).toHaveLength(0);
    expect(ev.ignoredCount).toBe(1);
  });

  it("cargo-audit: RUSTSEC ids", () => {
    const out = JSON.stringify({
      vulnerabilities: {
        found: true,
        count: 1,
        list: [
          {
            advisory: { id: "RUSTSEC-2023-0071", aliases: ["CVE-2023-49092"], title: "Marvin" },
            package: { name: "rsa", version: "0.9.6" },
          },
        ],
      },
    });
    const entries = parseAuditOutput("cargo-audit", out)!;
    const ev = evaluateAudit(entries, {
      failOn: "high",
      ignore: [ignore("RUSTSEC-2023-0071")],
      now: NOW,
    });
    expect(ev.blocking).toHaveLength(0);
  });

  it("govulncheck: counts only called vulnerabilities from the JSON stream", () => {
    const out = [
      JSON.stringify(
        {
          osv: {
            id: "GO-2024-0001",
            aliases: ["CVE-2024-1"],
            affected: [{ package: { name: "x/net" } }],
          },
        },
        null,
        2,
      ),
      JSON.stringify({ osv: { id: "GO-2024-0002", aliases: [] } }, null, 2),
      JSON.stringify({
        finding: { osv: "GO-2024-0001", trace: [{ module: "x/net", function: "Parse" }] },
      }),
      JSON.stringify({ finding: { osv: "GO-2024-0002", trace: [{ module: "x/text" }] } }), // imported, not called
    ].join("\n");
    const entries = parseAuditOutput("govulncheck", out)!;
    expect(entries.map((e) => e.advisories[0]!.key)).toEqual(["GO-2024-0001"]);
    const ev = evaluateAudit(entries, { failOn: "high", ignore: [ignore("CVE-2024-1")], now: NOW });
    expect(ev.blocking).toHaveLength(0);
  });

  it("parseJsonStream handles braces inside strings", () => {
    expect(parseJsonStream('{"a":"}{"}\n{"b":1}')).toEqual([{ a: "}{" }, { b: 1 }]);
  });
});

describe("resolveAuditTool", () => {
  const cfg = (stack: Record<string, unknown>, tool = "auto") =>
    ReinsConfigSchema.parse({
      harnessVersion: "0",
      preset: "lite",
      stack,
      commands: {},
      security: { depsAudit: { tool } },
    });
  it("maps every stack auto can select", () => {
    expect(resolveAuditTool(cfg({ language: "node" }))).toBe("npm");
    expect(resolveAuditTool(cfg({ language: "node", packageManager: "pnpm" }))).toBe("pnpm");
    expect(resolveAuditTool(cfg({ language: "node", packageManager: "yarn" }))).toBe("yarn");
    expect(resolveAuditTool(cfg({ language: "python" }))).toBe("pip-audit");
    expect(resolveAuditTool(cfg({ language: "rust" }))).toBe("cargo-audit");
    expect(resolveAuditTool(cfg({ language: "go" }))).toBe("govulncheck");
    expect(resolveAuditTool(cfg({ language: "other" }))).toBeNull();
    expect(resolveAuditTool(cfg({ language: "node" }, "pnpm"))).toBe("pnpm");
  });
});

describe("config validation — ignore entries", () => {
  const parse = (entry: unknown) =>
    ReinsConfigSchema.safeParse({
      harnessVersion: "0",
      preset: "lite",
      stack: { language: "node" },
      commands: {},
      security: { depsAudit: { ignore: [entry] } },
    });

  it("accepts a complete entry", () => {
    expect(parse(ignore(BRACES)).success).toBe(true);
  });

  it("rejects a missing reason with a readable path", () => {
    const res = parse({ id: BRACES, until: "2026-11-05" });
    expect(res.success).toBe(false);
    expect(formatConfigError(res.error)).toContain(
      "security.depsAudit.ignore[0].reason: reason is required",
    );
  });

  it("rejects a blank reason", () => {
    expect(parse({ id: BRACES, reason: "   ", until: "2026-11-05" }).success).toBe(false);
  });

  it("rejects a missing or malformed until", () => {
    expect(parse({ id: BRACES, reason: "x" }).success).toBe(false);
    expect(parse({ id: BRACES, reason: "x", until: "next year" }).success).toBe(false);
    expect(parse({ id: BRACES, reason: "x", until: "2026-02-30" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(parse({ ...ignore(BRACES), severity: "high" }).success).toBe(false);
  });
});

describe("doctor — deps allowlist", () => {
  const cfg = (entries: unknown[]) =>
    ReinsConfigSchema.parse({
      harnessVersion: "0",
      preset: "lite",
      stack: { language: "node" },
      commands: {},
      security: { depsAudit: { ignore: entries } },
    });

  it("is silent without entries", () => {
    expect(depsAllowlistResult(cfg([]), NOW)).toBeNull();
  });
  it("fails on an expired entry", () => {
    const r = depsAllowlistResult(cfg([ignore(BRACES, "2026-10-01")]), NOW)!;
    expect(r.status).toBe("fail");
    expect(r.summary).toContain(`ignore for ${BRACES} expired on 2026-10-01`);
  });
  it("warns when an entry expires within 14 days", () => {
    expect(depsAllowlistResult(cfg([ignore(BRACES, "2026-10-12")]), NOW)!.status).toBe("warn");
  });
  it("is ok otherwise, naming the earliest expiry", () => {
    const r = depsAllowlistResult(cfg([ignore(BRACES), ignore(FORGE, "2027-01-01")]), NOW)!;
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("earliest expiry 2026-11-05");
  });
});
