import path from "node:path";
import { loadConfig } from "../config/load";
import { AgentModelSchema, EFFORT_LEVELS, type ReinsConfig } from "../config/schema";
import { pathExists, readTextIfExists } from "../fs/read";
import { readManifest } from "../manifest/harness-manifest";
import { featureListCheck } from "../verify/state-checks";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorResult {
  id: string;
  status: DoctorStatus;
  summary: string;
}

export interface DoctorReport {
  installed: boolean;
  cliVersion: string;
  harnessVersion?: string;
  updateAvailable: boolean;
  results: DoctorResult[];
  ok: boolean;
}

function result(id: string, status: DoctorStatus, summary: string): DoctorResult {
  return { id, status, summary };
}

/** Lightweight frontmatter key presence check (no full YAML parse). */
function hasFrontmatterKeys(text: string, keys: string[]): boolean {
  if (!text.startsWith("---")) return false;
  const end = text.indexOf("\n---", 3);
  const fm = end > 0 ? text.slice(0, end) : text;
  return keys.every((k) => new RegExp(`(^|\\n)${k}:`).test(fm));
}

/** Read one frontmatter value, or null when the key is absent (no full YAML parse). */
function frontmatterValue(text: string, key: string): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  const fm = end > 0 ? text.slice(0, end) : text;
  const m = fm.match(new RegExp(`(^|\\n)${key}:\\s*([^\\n]*)`));
  return m ? (m[2] ?? "").trim() : null;
}

/** Validate optional model/effort frontmatter; absent keys mean inherit and are fine. */
function agentPolicyIssue(text: string): string | null {
  const model = frontmatterValue(text, "model");
  if (model !== null && !AgentModelSchema.safeParse(model).success)
    return `invalid model "${model}"`;
  const effort = frontmatterValue(text, "effort");
  if (effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(effort))
    return `invalid effort "${effort}" (${EFFORT_LEVELS.join("|")})`;
  return null;
}

function parseSemver(v: string): number[] {
  return v
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0);
}

function semverLt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

/** Inspect the installed harness for completeness and coherence. */
export async function runDoctor(cwd: string, cliVersion: string): Promise<DoctorReport> {
  const results: DoctorResult[] = [];

  const manifest = await readManifest(cwd);
  let config: ReinsConfig | null = null;
  try {
    config = await loadConfig(cwd);
  } catch {
    config = null;
  }

  results.push(
    manifest
      ? result("manifest", "ok", `manifest v${manifest.harnessVersion}`)
      : result("manifest", "fail", ".reins/manifest.json missing — harness not installed"),
  );
  results.push(
    config
      ? result("config", "ok", `preset ${config.preset}, stack ${config.stack.language}`)
      : result("config", "fail", "reins.config.json missing or invalid"),
  );

  if (!manifest || !config) {
    return {
      installed: false,
      cliVersion,
      harnessVersion: manifest?.harnessVersion,
      updateAvailable: false,
      results,
      ok: false,
    };
  }

  const cfg = config;
  const isOpencode = cfg.runtime === "opencode";

  // Gate wiring: Claude Code uses settings.json hooks; opencode uses a plugin.
  if (isOpencode) {
    const pluginText = await readTextIfExists(path.join(cwd, ".opencode/plugins/reins-verify.ts"));
    if (!pluginText) {
      results.push(result("gate", "fail", ".opencode/plugins/reins-verify.ts missing"));
    } else if (!pluginText.includes("npx reins")) {
      results.push(result("gate", "warn", "verify plugin present but does not run the reins gate"));
    } else {
      results.push(result("gate", "ok", "verify plugin wired"));
    }
    const configText = await readTextIfExists(path.join(cwd, "opencode.json"));
    if (!configText) {
      results.push(result("opencode-config", "fail", "opencode.json missing"));
    } else {
      try {
        JSON.parse(configText);
        results.push(result("opencode-config", "ok", "opencode.json valid"));
      } catch {
        results.push(result("opencode-config", "fail", "opencode.json is not valid JSON"));
      }
    }
  } else {
    const settingsText = await readTextIfExists(path.join(cwd, ".claude/settings.json"));
    if (!settingsText) {
      results.push(result("settings", "fail", ".claude/settings.json missing"));
    } else {
      try {
        const settings = JSON.parse(settingsText) as { hooks?: { Stop?: unknown } };
        const hasStop = JSON.stringify(settings.hooks?.Stop ?? "").includes("reins verify");
        results.push(
          result(
            "settings",
            hasStop ? "ok" : "warn",
            hasStop ? "hooks wired" : "Reins Stop hook not found",
          ),
        );
      } catch {
        results.push(result("settings", "fail", ".claude/settings.json is not valid JSON"));
      }
    }
  }

  // Agents (per preset) with valid frontmatter
  const agentsDir = isOpencode ? ".opencode/agents" : ".claude/agents";
  const requiredKeys = isOpencode ? ["description", "mode"] : ["name", "description", "tools"];
  const agents = ["leader", "implementer", "reviewer", "security-reviewer"];
  if (cfg.preset === "sdd") agents.push("spec_author");
  for (const agent of agents) {
    const text = await readTextIfExists(path.join(cwd, agentsDir, `${agent}.md`));
    // opencode models are `provider/model` strings; the alias-shaped policy
    // check doesn't apply, so it is skipped there.
    const policyIssue = text && !isOpencode ? agentPolicyIssue(text) : null;
    if (!text) results.push(result(`agent:${agent}`, "fail", `${agentsDir}/${agent}.md missing`));
    else if (!hasFrontmatterKeys(text, requiredKeys))
      results.push(result(`agent:${agent}`, "warn", `${agent}.md frontmatter incomplete`));
    else if (policyIssue)
      results.push(result(`agent:${agent}`, "warn", `${agent}.md: ${policyIssue}`));
    else results.push(result(`agent:${agent}`, "ok", `${agent}`));
  }

  // Core files + docs (opencode has no CLAUDE.md; AGENTS.md is its rules file)
  const coreFiles = [
    ...(isOpencode ? [] : ["CLAUDE.md"]),
    "AGENTS.md",
    "CHECKPOINTS.md",
    "docs/architecture.md",
    "docs/conventions.md",
    "docs/verification.md",
    "docs/security.md",
    "docs/four-rs.md",
  ];
  if (cfg.preset === "sdd") {
    coreFiles.push(
      "docs/sdd-workflow.md",
      "specs/_template/discovery.md",
      "specs/_template/requirements.md",
      "specs/_template/design.md",
      "specs/_template/tasks.md",
    );
  }
  const missingCore = [];
  for (const file of coreFiles) {
    if (!(await pathExists(path.join(cwd, file)))) missingCore.push(file);
  }
  results.push(
    missingCore.length
      ? result("files", "fail", `missing: ${missingCore.join(", ")}`)
      : result("files", "ok", `${coreFiles.length} core files present`),
  );

  // Living state
  const missingProgress = [];
  for (const file of ["progress/current.md", "progress/history.md"]) {
    if (!(await pathExists(path.join(cwd, file)))) missingProgress.push(file);
  }
  results.push(
    missingProgress.length
      ? result("progress", "fail", `missing: ${missingProgress.join(", ")}`)
      : result("progress", "ok", "living state present"),
  );

  // feature_list.json (reuse the verify invariant)
  const fl = await featureListCheck({ cwd, config: cfg, changed: false });
  results.push(result("feature-list", fl.status === "fail" ? "fail" : "ok", fl.summary));

  // Version drift
  let updateAvailable = false;
  if (semverLt(manifest.harnessVersion, cliVersion)) {
    updateAvailable = true;
    results.push(
      result(
        "version",
        "warn",
        `harness v${manifest.harnessVersion} < CLI v${cliVersion} — run \`reins update\``,
      ),
    );
  } else {
    results.push(result("version", "ok", `up to date (v${manifest.harnessVersion})`));
  }

  const ok = !results.some((r) => r.status === "fail");
  return {
    installed: true,
    cliVersion,
    harnessVersion: manifest.harnessVersion,
    updateAvailable,
    results,
    ok,
  };
}

export function computeDoctorExit(report: DoctorReport): number {
  if (!report.installed) return 2;
  return report.ok ? 0 : 1;
}
