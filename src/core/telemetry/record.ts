import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathExists, readTextIfExists } from "../fs/read";

export interface PricePerMtok {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Approximate Claude pricing in USD per million tokens. Prices change over time;
 * this is a best-effort default (overridable in a future release).
 */
const PRICING = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
} satisfies Record<string, PricePerMtok>;

function priceFor(model: string | undefined): PricePerMtok {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return PRICING.opus;
  if (m.includes("haiku")) return PRICING.haiku;
  return PRICING.sonnet;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model?: string;
}

/** Sum token usage across all assistant messages in a transcript JSONL. */
export function sumTranscriptUsage(jsonl: string): Usage {
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: any;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = record.message ?? record;
    const u = message?.usage;
    if (u) {
      usage.inputTokens += Number(u.input_tokens) || 0;
      usage.outputTokens += Number(u.output_tokens) || 0;
      usage.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
      usage.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
    }
    if (typeof message?.model === "string") usage.model = message.model;
  }
  return usage;
}

export function computeCostUsd(usage: Usage): number {
  const p = priceFor(usage.model);
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheCreationTokens * p.cacheWrite +
      usage.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}

export interface TelemetryRecord {
  ts: string;
  hook?: string;
  sessionId?: string;
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd: number;
}

export interface RecordTelemetryOptions {
  cwd: string;
  payloadJson: string;
  hook?: string;
  now: string;
}

export interface RecordTelemetryResult {
  recorded: boolean;
  record: TelemetryRecord;
}

/**
 * Parse a SubagentStop hook payload, best-effort sum its transcript usage, and
 * append one line to progress/telemetry.jsonl. Falls back to a bare subagent
 * count when usage is unavailable. Only writes inside a Reins harness.
 */
export async function recordTelemetry(
  opts: RecordTelemetryOptions,
): Promise<RecordTelemetryResult> {
  let payload: any = {};
  try {
    payload = opts.payloadJson ? JSON.parse(opts.payloadJson) : {};
  } catch {
    payload = {};
  }

  const sessionId = payload.session_id ?? payload.sessionId;
  const transcriptRaw = payload.transcript_path ?? payload.transcriptPath;

  let record: TelemetryRecord = {
    ts: opts.now,
    hook: opts.hook,
    sessionId,
    model: null,
    costUsd: 0,
  };

  if (typeof transcriptRaw === "string" && transcriptRaw.length > 0) {
    const transcriptPath = path.isAbsolute(transcriptRaw)
      ? transcriptRaw
      : path.join(opts.cwd, transcriptRaw);
    const jsonl = await readTextIfExists(transcriptPath);
    if (jsonl) {
      const usage = sumTranscriptUsage(jsonl);
      record = {
        ts: opts.now,
        hook: opts.hook,
        sessionId,
        model: usage.model ?? null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd: computeCostUsd(usage),
      };
    }
  }

  // Only persist inside an actual harness.
  if (!(await pathExists(path.join(opts.cwd, "reins.config.json")))) {
    return { recorded: false, record };
  }

  const dir = path.join(opts.cwd, "progress");
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "telemetry.jsonl"), JSON.stringify(record) + "\n", "utf8");
  return { recorded: true, record };
}
