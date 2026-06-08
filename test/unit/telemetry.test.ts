import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getStatus } from "../../src/core/status/run";
import {
  computeCostUsd,
  recordTelemetry,
  sumTranscriptUsage,
} from "../../src/core/telemetry/record";
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
  it("records transcript usage and status picks it up", async () => {
    const cwd = await inited();
    const transcriptPath = path.join(cwd, "transcript.jsonl");
    await writeFile(transcriptPath, TRANSCRIPT);

    const result = await recordTelemetry({
      cwd,
      payloadJson: JSON.stringify({ session_id: "s1", transcript_path: transcriptPath }),
      hook: "SubagentStop",
      now: "2026-06-08T00:00:00.000Z",
    });
    expect(result.recorded).toBe(true);
    expect(result.record.costUsd).toBeCloseTo(0.0108, 6);

    const status = await getStatus(cwd);
    expect(status.telemetry?.subagents).toBe(1);
    expect(status.telemetry?.costUsd).toBeCloseTo(0.0108, 6);
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
