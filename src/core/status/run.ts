import path from "node:path";
import { loadConfig } from "../config/load";
import { normalizeFeatures, orderQueue } from "../features/deps";
import { readJsonIfExists } from "../fs/read";
import { readManifest } from "../manifest/harness-manifest";
import { readTelemetry, summarizeTelemetry } from "../telemetry/report";
import { laneOf } from "../verify/state-checks";

export interface StatusTelemetry {
  entries: number;
  /** Subagent runs in the latest session. */
  subagents: number;
  costUsd: number;
  /** Total subagent wall time in the latest session. */
  durationMs: number;
  /** Pre-0.11 cumulative records, excluded from the numbers above. */
  legacyRecords: number;
}

export interface StatusReport {
  installed: boolean;
  harnessVersion?: string;
  preset?: string;
  total: number;
  counts: Record<string, number>;
  active: { slug: string; title?: string; lane: string } | null;
  pending: string[];
  /** The same queue as `pending`, with each feature's state and lane. */
  queue: { slug: string; state: string; lane: string }[];
  telemetry: StatusTelemetry | null;
}

interface FeatureList {
  features?: { slug?: string; title?: string; state?: string; lane?: string }[];
}

/** Telemetry for the latest session, from v2 (per-subagent) records only. */
async function statusTelemetry(cwd: string): Promise<StatusTelemetry | null> {
  const data = await readTelemetry(cwd);
  if (!data) return null;
  const s = summarizeTelemetry(data.records, data.legacy, "latest");
  return {
    entries: data.records.length + data.legacy,
    subagents: s.runs,
    costUsd: s.costUsd,
    durationMs: s.durationMs,
    legacyRecords: data.legacy,
  };
}

export async function getStatus(cwd: string): Promise<StatusReport> {
  const empty: StatusReport = {
    installed: false,
    total: 0,
    counts: {},
    active: null,
    pending: [],
    queue: [],
    telemetry: null,
  };

  const config = await loadConfig(cwd).catch(() => null);
  const fl = await readJsonIfExists<FeatureList>(path.join(cwd, "feature_list.json"));
  if (!config || !fl) return empty;

  const manifest = await readManifest(cwd);
  const features = Array.isArray(fl.features) ? fl.features : [];

  const counts: Record<string, number> = {};
  for (const f of features) {
    const state = typeof f.state === "string" ? f.state : "unknown";
    counts[state] = (counts[state] ?? 0) + 1;
  }

  const activeFeature =
    features.find((f) => f.state === "in_progress") ??
    features.find((f) => f.state === "analyzing");
  // Dependency-ordered queue of `pending` + `approved` slugs; `approved`
  // features whose deps are all `done` come first.
  const pending = orderQueue(normalizeFeatures(features)).slice(0, 8);

  return {
    installed: true,
    harnessVersion: manifest?.harnessVersion ?? config.harnessVersion,
    preset: config.preset,
    total: features.length,
    counts,
    active: activeFeature
      ? {
          slug: String(activeFeature.slug),
          title: activeFeature.title,
          lane: laneOf(activeFeature),
        }
      : null,
    pending,
    queue: pending.map((slug) => {
      const f = features.find((x) => x.slug === slug);
      return { slug, state: String(f?.state ?? "unknown"), lane: f ? laneOf(f) : "full" };
    }),
    telemetry: await statusTelemetry(cwd),
  };
}
