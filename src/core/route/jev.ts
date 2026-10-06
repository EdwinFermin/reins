import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Lane, RouterConfig } from "../config/schema";
import {
  COMPLEXITIES,
  IMPLEMENTER_MODELS,
  type Complexity,
  type ImplementerModel,
  type RouteContext,
  type RouteSignals,
  type SignalKey,
} from "./types";

/**
 * Jev (TypeSafe) as a triage classifier. One request carries every question —
 * Jev answers them in parallel — and each answer comes back as a choice plus a
 * confidence. Jev only *recommends*: it never runs anything, and the leader
 * may override it.
 *
 * Wire format (POST {url}):
 *   { model, state: "<task + project context>", questions: { id: { type: "choice", instructions, criteria: { option: description } } } }
 *   → { answers: { id: { choice, confidence } } }
 */

export const JEV_KEY_ENV = "TYPESAFE_API_KEY";

const RC_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile"];

/**
 * The Jev API key: the environment first, then a literal
 * `export TYPESAFE_API_KEY=…` line in the user's shell rc files — agent
 * sessions don't always source them, so a key that works in the terminal
 * would otherwise silently disappear. Only literal values are read (no
 * `$VAR` expansion, no command substitution).
 */
export function resolveJevKey(
  env: Record<string, string | undefined>,
  home: string = os.homedir(),
): string | null {
  const fromEnv = env[JEV_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const re = new RegExp(`^\\s*(?:export\\s+)?${JEV_KEY_ENV}=['"]?([A-Za-z0-9._~+/=-]+)['"]?\\s*$`);
  for (const name of RC_FILES) {
    let text: string;
    try {
      text = readFileSync(path.join(home, name), "utf8");
    } catch {
      continue;
    }
    let found: string | null = null;
    for (const line of text.split("\n")) {
      const m = re.exec(line);
      if (m?.[1]) found = m[1]; // last assignment wins, as in the shell
    }
    if (found) return found;
  }
  return null;
}

interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

const LANE_CRITERIA: Record<Lane, string> = {
  quick:
    "A tiny, low-risk change a developer finishes in minutes: a typo, copy or label text, a color or spacing tweak, a rename, a log line, a one-line fix. No design decisions, no new behavior worth planning.",
  chore:
    "Mechanical maintenance driven by an external guide rather than product decisions: upgrading a framework or SDK (e.g. Expo, React Native, Next.js), bumping dependencies, running codemods, fixing deprecations, migrating config to a new tool version. Work is an apply → test → fix loop.",
  standard:
    "Ordinary feature work or a bug fix across a few files with clear intent: a short plan and one review are enough. Most day-to-day tasks.",
  full: "Large, risky, or ambiguous work that needs discovery, open questions answered, and an approved spec first: authentication, payments, permissions, data model or schema changes, new modules or architecture, cross-cutting refactors, anything hard to reverse.",
};

const COMPLEXITY_CRITERIA: Record<Complexity, string> = {
  trivial: "One file, a few lines, no tests to design.",
  small: "One to three files, one behavior, straightforward tests.",
  medium:
    "Several files or layers, a handful of behaviors or breaking changes to work through; under a day of focused work.",
  large: "Many files or modules, multiple interacting behaviors, or real design uncertainty.",
};

const MODEL_CRITERIA: Record<ImplementerModel, string> = {
  haiku:
    "Fast, cheap model for mechanical, fully specified edits: text and style tweaks, renames, config values, simple tests.",
  sonnet:
    "Balanced default for typical coding: features and bug fixes across a few files, dependency upgrades with breaking changes to fix, writing solid tests.",
  opus: "Strongest model for hard reasoning: architecture, subtle concurrency or state bugs, security-sensitive logic, large refactors, ambiguous debugging.",
};

export function buildQuestions(): Record<SignalKey, ChoiceQuestion> {
  return {
    lane: {
      type: "choice",
      instructions:
        "Which process lane fits this software task? Pick the lightest lane that is still safe.",
      criteria: LANE_CRITERIA,
    },
    complexity: {
      type: "choice",
      instructions: "How complex is this software task to implement and test?",
      criteria: COMPLEXITY_CRITERIA,
    },
    implementerModel: {
      type: "choice",
      instructions:
        "Which AI model should implement this task? Pick the cheapest model that will do it well.",
      criteria: MODEL_CRITERIA,
    },
    security: {
      type: "choice",
      instructions:
        "Does this task touch security-sensitive code: authentication, sessions, secrets or tokens, payments, permissions, or handling untrusted input?",
      criteria: {
        yes: "It touches security-sensitive code.",
        no: "It does not touch security-sensitive code.",
      },
    },
    ui: {
      type: "choice",
      instructions:
        "Does this task change user interface: screens, components, styles, layout, copy, or animation?",
      criteria: {
        yes: "It changes user interface.",
        no: "It does not change user interface.",
      },
    },
  };
}

/** The `state` Jev classifies: the task plus just enough project context. */
export function buildState(task: string, ctx: RouteContext): string {
  const frameworks = ctx.frameworks.length ? ctx.frameworks.join(", ") : "none detected";
  return [
    `Software task: ${task.trim().slice(0, 4000)}`,
    "",
    `Project: ${ctx.language}; frameworks: ${frameworks}.`,
  ].join("\n");
}

export interface JevAnswer<T> {
  value: T;
  confidence: number;
}

export type JevSignals = Partial<{ [K in SignalKey]: JevAnswer<RouteSignals[K]> }>;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface AskJevOptions {
  apiKey: string;
  router: RouterConfig;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

function parseAnswer(raw: unknown): { choice: string; confidence: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const { choice, confidence } = raw as { choice?: unknown; confidence?: unknown };
  if (typeof choice !== "string" || typeof confidence !== "number") return null;
  if (!Number.isFinite(confidence)) return null;
  return { choice, confidence: Math.max(0, Math.min(1, confidence)) };
}

/**
 * Ask Jev every triage question in one call. Throws on transport errors,
 * timeouts, and non-2xx responses (the caller falls back to the heuristic);
 * answers that are missing or outside the offered options are dropped.
 */
export async function askJev(
  task: string,
  ctx: RouteContext,
  opts: AskJevOptions,
): Promise<JevSignals> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!doFetch) throw new Error("fetch is not available in this Node.js runtime");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.router.timeoutMs);
  let body: unknown;
  try {
    const res = await doFetch(opts.router.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.router.model,
        state: buildState(task, ctx),
        questions: buildQuestions(),
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`timed out after ${opts.router.timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const answers = (body as { answers?: Record<string, unknown> } | null)?.answers;
  if (!answers || typeof answers !== "object") throw new Error("response has no answers");

  const out: JevSignals = {};
  const lane = parseAnswer(answers.lane);
  if (lane && lane.choice in LANE_CRITERIA)
    out.lane = { value: lane.choice as Lane, confidence: lane.confidence };
  const complexity = parseAnswer(answers.complexity);
  if (complexity && (COMPLEXITIES as readonly string[]).includes(complexity.choice))
    out.complexity = { value: complexity.choice as Complexity, confidence: complexity.confidence };
  const model = parseAnswer(answers.implementerModel);
  if (model && (IMPLEMENTER_MODELS as readonly string[]).includes(model.choice))
    out.implementerModel = {
      value: model.choice as ImplementerModel,
      confidence: model.confidence,
    };
  for (const key of ["security", "ui"] as const) {
    const a = parseAnswer(answers[key]);
    if (a && (a.choice === "yes" || a.choice === "no"))
      out[key] = { value: a.choice === "yes", confidence: a.confidence };
  }
  return out;
}
