import path from "node:path";
import { readTextIfExists } from "../fs/read";
import { TIME_KINDS, type TelemetryRecord, type TimeKind } from "./record";

export interface RoleSummary {
  agentType: string;
  runs: number;
  durationMs: number;
  hookMs: number;
  bashMs: Record<TimeKind, number>;
  outputTokens: number;
  costUsd: number;
}

export interface TelemetrySummary {
  /** The session summarized (the latest one unless asked otherwise); null = all sessions. */
  sessionId: string | null;
  runs: number;
  durationMs: number;
  hookMs: number;
  bashMs: Record<TimeKind, number>;
  costUsd: number;
  byRole: RoleSummary[];
  /** Pre-0.11 records (cumulative main-session usage): counted, never summed. */
  legacyRecords: number;
}

const zeroKinds = (): Record<TimeKind, number> => ({
  build: 0,
  e2e: 0,
  test: 0,
  install: 0,
  other: 0,
});

/** Parse progress/telemetry.jsonl into v2 records plus a count of legacy ones. */
export async function readTelemetry(
  cwd: string,
): Promise<{ records: TelemetryRecord[]; legacy: number } | null> {
  const text = await readTextIfExists(path.join(cwd, "progress", "telemetry.jsonl"));
  if (text == null) return null;
  const records: TelemetryRecord[] = [];
  let legacy = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<TelemetryRecord>;
      if (r.v === 2) records.push(r as TelemetryRecord);
      else legacy += 1;
    } catch {
      // ignore malformed lines
    }
  }
  return { records, legacy };
}

/**
 * Summarize subagent telemetry by role: wall time, where Bash time went
 * (builds, e2e, tests, installs), hook time, tokens, and estimated cost.
 * `session`: an id (or prefix), "latest" (default), or "all".
 */
export function summarizeTelemetry(
  records: TelemetryRecord[],
  legacy: number,
  session: string = "latest",
): TelemetrySummary {
  let sessionId: string | null = null;
  let picked = records;
  if (session !== "all") {
    sessionId =
      session === "latest"
        ? ([...records].reverse().find((r) => r.sessionId)?.sessionId ?? null)
        : (records.find((r) => r.sessionId?.startsWith(session))?.sessionId ?? session);
    picked = records.filter((r) => r.sessionId === sessionId);
  }

  const roles = new Map<string, RoleSummary>();
  const total: TelemetrySummary = {
    sessionId,
    runs: 0,
    durationMs: 0,
    hookMs: 0,
    bashMs: zeroKinds(),
    costUsd: 0,
    byRole: [],
    legacyRecords: legacy,
  };
  for (const r of picked) {
    const type = r.agentType ?? "unknown";
    let role = roles.get(type);
    if (!role) {
      role = {
        agentType: type,
        runs: 0,
        durationMs: 0,
        hookMs: 0,
        bashMs: zeroKinds(),
        outputTokens: 0,
        costUsd: 0,
      };
      roles.set(type, role);
    }
    for (const target of [role, total]) {
      target.runs += 1;
      target.durationMs += r.durationMs ?? 0;
      target.hookMs += r.hookMs ?? 0;
      target.costUsd += r.costUsd ?? 0;
      for (const k of TIME_KINDS) target.bashMs[k] += r.bashMs?.[k] ?? 0;
    }
    role.outputTokens += r.outputTokens ?? 0;
  }
  total.byRole = [...roles.values()].sort((a, b) => b.durationMs - a.durationMs);
  return total;
}

const min = (ms: number): string => `${(ms / 60_000).toFixed(1)}m`;

export function formatTelemetrySummary(s: TelemetrySummary): string {
  const lines = [
    "",
    `Reins telemetry — ${s.sessionId ? `session ${s.sessionId.slice(0, 8)}` : "all sessions"}`,
  ];
  if (s.runs === 0) {
    lines.push("  No subagent runs recorded yet (Reins ≥ 0.11 records them on SubagentStop).");
  } else {
    lines.push(
      `  ${s.runs} subagent run(s) · ${min(s.durationMs)} of subagent time · ~$${s.costUsd.toFixed(2)} (list-price estimate)`,
    );
    const bashTotal = TIME_KINDS.reduce((n, k) => n + s.bashMs[k], 0);
    lines.push(
      `  Shell time ${min(bashTotal)}: ` +
        TIME_KINDS.filter((k) => s.bashMs[k] > 0)
          .map((k) => `${k} ${min(s.bashMs[k])}`)
          .join(" · ") +
        ` · hooks ${min(s.hookMs)}`,
    );
    lines.push("");
    lines.push(
      "  role                 runs     time    build    e2e    test   hooks   out-tok    cost",
    );
    for (const r of s.byRole) {
      lines.push(
        `  ${r.agentType.padEnd(20)} ${String(r.runs).padStart(4)} ${min(r.durationMs).padStart(8)} ${min(r.bashMs.build).padStart(8)} ${min(r.bashMs.e2e).padStart(6)} ${min(r.bashMs.test).padStart(7)} ${min(r.hookMs).padStart(7)} ${String(Math.round(r.outputTokens / 1000) + "k").padStart(9)} ${("$" + r.costUsd.toFixed(2)).padStart(7)}`,
      );
    }
  }
  if (s.legacyRecords > 0) {
    lines.push("");
    lines.push(
      `  ${s.legacyRecords} pre-0.11 record(s) ignored: they held cumulative main-session usage, not per-subagent data.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
