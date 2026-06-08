import path from "node:path";
import { loadConfig } from "../config/load";
import { readJsonIfExists, readTextIfExists } from "../fs/read";
import { readManifest } from "../manifest/harness-manifest";

export interface StatusTelemetry {
  entries: number;
  subagents: number;
  costUsd: number;
}

export interface StatusReport {
  installed: boolean;
  harnessVersion?: string;
  preset?: string;
  total: number;
  counts: Record<string, number>;
  active: { slug: string; title?: string } | null;
  pending: string[];
  telemetry: StatusTelemetry | null;
}

interface FeatureList {
  features?: { slug?: string; title?: string; state?: string }[];
}

async function readTelemetry(cwd: string): Promise<StatusTelemetry | null> {
  const text = await readTextIfExists(path.join(cwd, "progress", "telemetry.jsonl"));
  if (!text) return null;
  let entries = 0;
  let costUsd = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as { costUsd?: number };
      entries += 1;
      costUsd += Number(record.costUsd) || 0;
    } catch {
      // ignore malformed lines
    }
  }
  return { entries, subagents: entries, costUsd };
}

export async function getStatus(cwd: string): Promise<StatusReport> {
  const empty: StatusReport = {
    installed: false,
    total: 0,
    counts: {},
    active: null,
    pending: [],
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

  const activeFeature = features.find((f) => f.state === "in_progress" || f.state === "analyzing");
  const pending = features
    .filter((f) => f.state === "pending")
    .map((f) => String(f.slug))
    .slice(0, 8);

  return {
    installed: true,
    harnessVersion: manifest?.harnessVersion ?? config.harnessVersion,
    preset: config.preset,
    total: features.length,
    counts,
    active: activeFeature ? { slug: String(activeFeature.slug), title: activeFeature.title } : null,
    pending,
    telemetry: await readTelemetry(cwd),
  };
}
