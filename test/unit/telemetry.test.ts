import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getStatus } from "../../src/core/status/run";
import {
  analyzeTranscript,
  classifyCommand,
  computeCostUsd,
  recordTelemetry,
  sumTranscriptUsage,
} from "../../src/core/telemetry/record";
import {
  formatTelemetrySummary,
  readTelemetry,
  summarizeTelemetry,
} from "../../src/core/telemetry/report";
import { runInit } from "../../src/core/init/run";

const TRANSCRIPT = [
  JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 600, output_tokens: 200, cache_read_input_tokens: 1000 },
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: { model: "claude-sonnet-4-6", usage: { input_tokens: 400, output_tokens: 300 } },
  }),
  "not json — ignored",
].join("\n");

describe("sumTranscriptUsage + computeCostUsd", () => {
  it("sums usage and picks the model", () => {
    const usage = sumTranscriptUsage(TRANSCRIPT);
    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(500);
    expect(usage.cacheReadTokens).toBe(1000);
    expect(usage.model).toBe("claude-sonnet-4-6");
  });

  it("computes a sonnet-priced cost", () => {
    // 1000*3 + 500*15 + 1000*0.30 (cache read) = 3000 + 7500 + 300 = 10800 / 1e6
    const cost = computeCostUsd({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 1000,
      model: "claude-sonnet-4-6",
    });
    expect(cost).toBeCloseTo(0.0108, 6);
  });
});

async function inited(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-telemetry-"));
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --version" } }),
  );
  await runInit({ cwd, preset: "lite", harnessVersion: "0.1.0", installGitHook: false });
  return cwd;
}

describe("recordTelemetry", () => {
  it("records the subagent's own transcript and status picks it up", async () => {
    const cwd = await inited();
    const transcriptPath = path.join(cwd, "agent.jsonl");
    await writeFile(transcriptPath, TRANSCRIPT);

    const result = await recordTelemetry({
      cwd,
      payloadJson: JSON.stringify({
        session_id: "s1",
        transcript_path: path.join(cwd, "main.jsonl"),
        agent_id: "a1",
        agent_type: "implementer",
        agent_transcript_path: transcriptPath,
      }),
      hook: "SubagentStop",
      now: "2026-06-08T00:00:00.000Z",
    });
    expect(result.recorded).toBe(true);
    expect(result.record).toMatchObject({ v: 2, agentId: "a1", agentType: "implementer" });
    expect(result.record.costUsd).toBeCloseTo(0.0108, 6);

    const status = await getStatus(cwd);
    expect(status.telemetry?.subagents).toBe(1);
    expect(status.telemetry?.costUsd).toBeCloseTo(0.0108, 6);
  });

  it("never reads the cumulative main-session transcript", async () => {
    const cwd = await inited();
    const main = path.join(cwd, "main.jsonl");
    await writeFile(main, TRANSCRIPT);
    const result = await recordTelemetry({
      cwd,
      payloadJson: JSON.stringify({ session_id: "s1", transcript_path: main }),
      hook: "SubagentStop",
      now: "2026-06-08T00:00:00.000Z",
    });
    expect(result.record.costUsd).toBe(0);
    expect(result.record.inputTokens).toBeUndefined();
  });

  it("derives the subagent transcript from the session layout and reads its meta", async () => {
    const cwd = await inited();
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "reins-cc-project-"));
    const subDir = path.join(projectDir, "sess-1", "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(path.join(subDir, "agent-abc.jsonl"), TRANSCRIPT);
    await writeFile(
      path.join(subDir, "agent-abc.meta.json"),
      JSON.stringify({ agentType: "reviewer", description: "Review csv-export" }),
    );
    const payload = JSON.stringify({
      session_id: "sess-1",
      transcript_path: path.join(projectDir, "sess-1.jsonl"),
      agent_id: "abc",
    });
    const first = await recordTelemetry({ cwd, payloadJson: payload, now: "t1" });
    expect(first.record).toMatchObject({ agentType: "reviewer", description: "Review csv-export" });
    expect(first.record.costUsd).toBeGreaterThan(0);
    // SubagentStop firing twice for one subagent records it once.
    expect((await recordTelemetry({ cwd, payloadJson: payload, now: "t2" })).recorded).toBe(false);
  });

  it("falls back to a bare subagent count without a transcript", async () => {
    const cwd = await inited();
    const result = await recordTelemetry({
      cwd,
      payloadJson: JSON.stringify({ session_id: "s2" }),
      hook: "SubagentStop",
      now: "2026-06-08T00:00:01.000Z",
    });
    expect(result.recorded).toBe(true);
    expect(result.record.costUsd).toBe(0);

    const line = (await readFile(path.join(cwd, "progress/telemetry.jsonl"), "utf8")).trim();
    expect(JSON.parse(line).sessionId).toBe("s2");
  });

  it("does not record outside a harness", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "reins-telemetry-bare-"));
    const result = await recordTelemetry({
      cwd,
      payloadJson: "{}",
      hook: "SubagentStop",
      now: "2026-06-08T00:00:02.000Z",
    });
    expect(result.recorded).toBe(false);
  });
});

describe("analyzeTranscript", () => {
  const line = (o: unknown): string => JSON.stringify(o);
  const jsonl = [
    // One message, three content blocks: usage repeats; the last one is final.
    line({
      type: "assistant",
      timestamp: "2026-10-05T10:00:00.000Z",
      message: {
        id: "m1",
        model: "claude-opus-5-5",
        usage: { output_tokens: 8, cache_read_input_tokens: 1000 },
        content: [{ type: "thinking" }],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-10-05T10:00:01.000Z",
      message: {
        id: "m1",
        model: "claude-opus-5-5",
        usage: { output_tokens: 200, cache_read_input_tokens: 1000 },
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "npx expo run:ios --device 'iPhone 18'" },
          },
        ],
      },
    }),
    line({
      type: "user",
      timestamp: "2026-10-05T10:06:01.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "t1" }] },
    }),
    line({
      type: "assistant",
      timestamp: "2026-10-05T10:06:02.000Z",
      message: {
        id: "m2",
        model: "claude-opus-5-5",
        usage: { output_tokens: 50 },
        content: [{ type: "tool_use", id: "t2", name: "Edit", input: {} }],
      },
    }),
    line({
      attachment: { type: "hook_success", hookEvent: "PostToolUse", durationMs: 12_000 },
      type: "attachment",
      timestamp: "2026-10-05T10:06:15.000Z",
    }),
    line({
      type: "assistant",
      timestamp: "2026-10-05T10:06:20.000Z",
      message: {
        id: "m3",
        usage: { output_tokens: 5 },
        content: [
          {
            type: "tool_use",
            id: "t3",
            name: "Bash",
            input: { command: "maestro test .maestro/smoke.yaml" },
          },
        ],
      },
    }),
    line({
      type: "user",
      timestamp: "2026-10-05T10:08:20.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "t3" }] },
    }),
  ].join("\n");

  it("counts usage once per message, and splits time by kind", () => {
    const s = analyzeTranscript(jsonl);
    expect(s.outputTokens).toBe(255); // 200 + 50 + 5, not 8 + 200 + 50 + 5
    expect(s.cacheReadTokens).toBe(1000); // not 2000
    expect(s.model).toBe("claude-opus-5-5");
    expect(s.bashMs.build).toBe(360_000);
    expect(s.bashMs.e2e).toBe(120_000);
    expect(s.hookMs).toBe(12_000);
    expect(s).toMatchObject({ toolCalls: 3, edits: 1 });
    expect(s.firstTs).toBe("2026-10-05T10:00:00.000Z");
    expect(s.lastTs).toBe("2026-10-05T10:08:20.000Z");
  });

  it("classifies commands", () => {
    expect(classifyCommand("cd ios && pod install")).toBe("build");
    expect(classifyCommand("xcrun simctl io booted screenshot a.png")).toBe("e2e");
    expect(classifyCommand("npx jest --ci")).toBe("test");
    expect(classifyCommand("npx expo install --fix")).toBe("install");
    expect(classifyCommand("git status")).toBe("other");
  });

  it("prices current models", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    expect(computeCostUsd({ ...usage, model: "claude-opus-5-5" })).toBe(20);
    expect(computeCostUsd({ ...usage, model: "claude-opus-4-8" })).toBe(25);
    expect(computeCostUsd({ ...usage, model: "claude-sonnet-5-5" })).toBe(10);
    expect(computeCostUsd({ ...usage, model: "claude-haiku-4-5-20251001" })).toBe(5);
    expect(computeCostUsd({ ...usage, model: "claude-fable-5-1" })).toBe(50);
  });
});

describe("summarizeTelemetry", () => {
  it("summarizes the latest session by role and ignores legacy cumulative records", async () => {
    const cwd = await inited();
    const rec = (o: Record<string, unknown>): string =>
      JSON.stringify({ v: 2, ts: "t", model: null, costUsd: 1, ...o });
    await writeFile(
      path.join(cwd, "progress", "telemetry.jsonl"),
      [
        JSON.stringify({ ts: "t", sessionId: "old", costUsd: 4590.6 }), // legacy
        rec({ sessionId: "s1", agentType: "implementer", durationMs: 60_000 }),
        rec({
          sessionId: "s2",
          agentType: "implementer",
          durationMs: 120_000,
          bashMs: { build: 90_000, e2e: 0, test: 0, install: 0, other: 0 },
        }),
        rec({ sessionId: "s2", agentType: "reviewer", durationMs: 30_000 }),
        rec({ sessionId: "s2", agentType: "implementer", durationMs: 60_000 }),
      ].join("\n") + "\n",
    );
    const data = (await readTelemetry(cwd))!;
    const s = summarizeTelemetry(data.records, data.legacy);
    expect(s.sessionId).toBe("s2");
    expect(s).toMatchObject({ runs: 3, durationMs: 210_000, costUsd: 3, legacyRecords: 1 });
    expect(s.bashMs.build).toBe(90_000);
    expect(s.byRole.map((r) => [r.agentType, r.runs])).toEqual([
      ["implementer", 2],
      ["reviewer", 1],
    ]);
    expect(summarizeTelemetry(data.records, data.legacy, "all").runs).toBe(4);
    expect(formatTelemetrySummary(s)).toContain("1 pre-0.11 record(s) ignored");
  });
});
