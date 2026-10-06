import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, readTextIfExists } from "../fs/read";

export interface PricePerMtok {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Claude API list prices in USD per million tokens (base input, output,
 * 5-minute cache write, cache read), from
 * https://platform.claude.com/docs/en/about-claude/pricing — checked 2026-10.
 * Matched by model ID, most specific first; unknown models price as Sonnet 4.x.
 * Telemetry cost is an estimate: batch, long-context, and regional pricing
 * are not modeled.
 */
const PRICING: { match: RegExp; price: PricePerMtok }[] = [
  { match: /fable-5-1/, price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 } },
  { match: /fable/, price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  { match: /opus-5/, price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
  { match: /opus-4-[5-9]/, price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { match: /opus/, price: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { match: /sonnet-5/, price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
  { match: /haiku-4/, price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
  { match: /haiku/, price: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 } },
];
const DEFAULT_PRICE: PricePerMtok = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

export function priceFor(model: string | undefined): PricePerMtok {
  const m = (model ?? "").toLowerCase();
  return PRICING.find((p) => p.match.test(m))?.price ?? DEFAULT_PRICE;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model?: string;
}

/** Where a subagent's Bash time went — the categories that dominate wall time. */
export const TIME_KINDS = ["build", "e2e", "test", "install", "other"] as const;
export type TimeKind = (typeof TIME_KINDS)[number];

const KIND_PATTERNS: [Exclude<TimeKind, "other">, RegExp][] = [
  [
    "build",
    /xcodebuild|\brun[:-](?:ios|android)\b|expo run|\bgradlew?\b|pod install|eas build|\barchive\b|\bprebuild\b|cargo build|\bgo build\b|docker build|npm run build|\bvite build\b|\bnext build\b/,
  ],
  // Simulator/emulator driving (screenshots, appearance, flows) is verification.
  ["e2e", /maestro|detox|playwright|cypress|\be2e\b|simctl|\badb\b/],
  [
    "test",
    /\bjest\b|vitest|pytest|\bnpm (?:run )?test\b|\b(?:pnpm|yarn|bun) test\b|go test|cargo test|reins verify|\btsc\b/,
  ],
  [
    "install",
    /\b(?:npm|pnpm|yarn|bun) (?:i|install|ci|add)\b|expo install|pip install|\buv (?:sync|add)\b|poetry install/,
  ],
];

export function classifyCommand(command: string): TimeKind {
  return KIND_PATTERNS.find(([, re]) => re.test(command))?.[0] ?? "other";
}

/** Everything telemetry extracts from one (subagent) transcript. */
export interface TranscriptStats extends Usage {
  firstTs: string | null;
  lastTs: string | null;
  toolCalls: number;
  edits: number;
  hookMs: number;
  bashMs: Record<TimeKind, number>;
}

function emptyStats(): TranscriptStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    firstTs: null,
    lastTs: null,
    toolCalls: 0,
    edits: 0,
    hookMs: 0,
    bashMs: { build: 0, e2e: 0, test: 0, install: 0, other: 0 },
  };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Analyze a transcript JSONL. Claude Code writes one line per content block,
 * each repeating the message's `usage`, so usage is counted once per message
 * id (taking the largest value seen — the final one).
 */
export function analyzeTranscript(jsonl: string): TranscriptStats {
  const stats = emptyStats();
  const byMessage = new Map<string, Omit<Usage, "model">>();
  let anonymous = 0;
  const bashStarts = new Map<string, { ts: string; command: string }>();

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: any;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ts: string | undefined =
      typeof record.timestamp === "string" ? record.timestamp : undefined;
    if (ts) {
      if (!stats.firstTs || ts < stats.firstTs) stats.firstTs = ts;
      if (!stats.lastTs || ts > stats.lastTs) stats.lastTs = ts;
    }

    const message = record.message ?? record;
    const u = message?.usage;
    if (u) {
      const usage = {
        inputTokens: Number(u.input_tokens) || 0,
        outputTokens: Number(u.output_tokens) || 0,
        cacheCreationTokens: Number(u.cache_creation_input_tokens) || 0,
        cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
      };
      const id = typeof message.id === "string" ? message.id : `anon-${anonymous++}`;
      const prev = byMessage.get(id);
      byMessage.set(
        id,
        prev
          ? {
              inputTokens: Math.max(prev.inputTokens, usage.inputTokens),
              outputTokens: Math.max(prev.outputTokens, usage.outputTokens),
              cacheCreationTokens: Math.max(prev.cacheCreationTokens, usage.cacheCreationTokens),
              cacheReadTokens: Math.max(prev.cacheReadTokens, usage.cacheReadTokens),
            }
          : usage,
      );
    }
    if (typeof message?.model === "string" && message.model !== "<synthetic>")
      stats.model = message.model;

    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === "tool_use") {
        stats.toolCalls += 1;
        if (EDIT_TOOLS.has(block.name)) stats.edits += 1;
        if (block.name === "Bash" && ts && typeof block.id === "string")
          bashStarts.set(block.id, { ts, command: String(block.input?.command ?? "") });
      } else if (block?.type === "tool_result" && ts && bashStarts.has(block.tool_use_id)) {
        const start = bashStarts.get(block.tool_use_id)!;
        const ms = Date.parse(ts) - Date.parse(start.ts);
        if (Number.isFinite(ms) && ms > 0) stats.bashMs[classifyCommand(start.command)] += ms;
        bashStarts.delete(block.tool_use_id);
      }
    }

    const attachment = record.attachment;
    if (
      attachment &&
      typeof attachment.durationMs === "number" &&
      /^hook_/.test(attachment.type ?? "")
    )
      stats.hookMs += attachment.durationMs;
    if (record.type === "system" && Array.isArray(record.hookInfos)) {
      for (const h of record.hookInfos)
        if (typeof h?.durationMs === "number") stats.hookMs += h.durationMs;
    }
  }

  for (const u of byMessage.values()) {
    stats.inputTokens += u.inputTokens;
    stats.outputTokens += u.outputTokens;
    stats.cacheCreationTokens += u.cacheCreationTokens;
    stats.cacheReadTokens += u.cacheReadTokens;
  }
  return stats;
}

/** Token usage of a transcript, counted once per message. */
export function sumTranscriptUsage(jsonl: string): Usage {
  const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model } =
    analyzeTranscript(jsonl);
  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model };
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

/**
 * One line of `progress/telemetry.jsonl` — one finished subagent.
 *
 * `v: 2` records describe the subagent's own transcript. Records without `v`
 * (Reins ≤ 0.10) were read from the *main* session transcript, so each one is
 * the cumulative usage of the whole session so far: they can't be summed, and
 * reports exclude their cost.
 */
export interface TelemetryRecord {
  v: 2;
  ts: string;
  hook?: string;
  sessionId?: string;
  agentId?: string;
  agentType?: string;
  description?: string;
  stopReason?: string;
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd: number;
  /** Wall time from the subagent's first to its last transcript entry. */
  durationMs?: number;
  /** Time spent in hooks (e.g. the PostToolUse verify) inside the subagent. */
  hookMs?: number;
  /** Time spent in Bash, by kind of command. */
  bashMs?: Record<TimeKind, number>;
  toolCalls?: number;
  edits?: number;
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

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * The subagent's own transcript: `agent_transcript_path` when the payload has
 * it, else derived from the layout Claude Code uses
 * (`<project>/<session>/subagents/agent-<id>.jsonl`). Never the main session
 * transcript — that is cumulative across every subagent.
 */
async function subagentTranscriptPath(payload: any, cwd: string): Promise<string | null> {
  const resolve = (p: string): string => (path.isAbsolute(p) ? p : path.join(cwd, p));
  const direct = str(payload.agent_transcript_path) ?? str(payload.agentTranscriptPath);
  if (direct) return resolve(direct);
  const main = str(payload.transcript_path) ?? str(payload.transcriptPath);
  const agentId = str(payload.agent_id) ?? str(payload.agentId);
  const sessionId = str(payload.session_id) ?? str(payload.sessionId);
  if (!main || !agentId || !sessionId) return null;
  const derived = path.join(
    path.dirname(resolve(main)),
    sessionId,
    "subagents",
    `agent-${agentId}.jsonl`,
  );
  return (await pathExists(derived)) ? derived : null;
}

/** `agent-<id>.meta.json` beside the transcript: agentType + the task description. */
async function readMeta(transcript: string): Promise<{ agentType?: string; description?: string }> {
  try {
    const meta = JSON.parse(await readFile(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return { agentType: str(meta.agentType), description: str(meta.description)?.slice(0, 120) };
  } catch {
    return {};
  }
}

/**
 * Parse a SubagentStop hook payload, analyze the subagent's own transcript
 * (tokens counted once per message, wall time, hook and Bash time), and append
 * one line to progress/telemetry.jsonl. Falls back to a bare subagent record
 * when the transcript is unavailable. Only writes inside a Reins harness, and
 * records each subagent once.
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

  const transcript = await subagentTranscriptPath(payload, opts.cwd);
  const meta = transcript ? await readMeta(transcript) : {};
  let record: TelemetryRecord = {
    v: 2,
    ts: opts.now,
    hook: opts.hook,
    sessionId: str(payload.session_id) ?? str(payload.sessionId),
    agentId: str(payload.agent_id) ?? str(payload.agentId),
    agentType: str(payload.agent_type) ?? meta.agentType,
    description: meta.description,
    stopReason: str(payload.stop_reason),
    model: null,
    costUsd: 0,
  };

  const jsonl = transcript ? await readTextIfExists(transcript) : null;
  if (jsonl) {
    const s = analyzeTranscript(jsonl);
    const durationMs =
      s.firstTs && s.lastTs ? Math.max(0, Date.parse(s.lastTs) - Date.parse(s.firstTs)) : undefined;
    record = {
      ...record,
      model: s.model ?? null,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      cacheReadTokens: s.cacheReadTokens,
      costUsd: Math.round(computeCostUsd(s) * 1e6) / 1e6,
      durationMs,
      hookMs: s.hookMs,
      bashMs: s.bashMs,
      toolCalls: s.toolCalls,
      edits: s.edits,
    };
  }

  // Only persist inside an actual harness.
  if (!(await pathExists(path.join(opts.cwd, "reins.config.json")))) {
    return { recorded: false, record };
  }

  const file = path.join(opts.cwd, "progress", "telemetry.jsonl");
  // SubagentStop can fire more than once for one subagent; record it once.
  if (record.agentId) {
    const existing = (await readTextIfExists(file)) ?? "";
    if (existing.includes(`"agentId":${JSON.stringify(record.agentId)}`))
      return { recorded: false, record };
  }

  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(record) + "\n", "utf8");
  return { recorded: true, record };
}
