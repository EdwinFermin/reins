import { RouterSchema, type Preset, type RouterConfig } from "../config/schema";
import { heuristicSignals } from "./heuristic";
import { askJev, JEV_KEY_ENV, resolveJevKey, type JevSignals, type AskJevOptions } from "./jev";
import type {
  ImplementerModel,
  ReviewerRole,
  RouteContext,
  RouteDecision,
  RouteSignals,
  RouteSource,
  SignalKey,
} from "./types";

export interface RouteTaskOptions {
  context: RouteContext;
  router?: RouterConfig;
  /** Force a provider for this call (`reins route --provider`). */
  provider?: RouterConfig["provider"];
  env?: Record<string, string | undefined>;
  /** Where to look for shell rc files holding the key (tests). */
  home?: string;
  fetchImpl?: AskJevOptions["fetchImpl"];
}

const SIGNAL_KEYS: SignalKey[] = ["lane", "complexity", "implementerModel", "security", "ui"];

/**
 * Take each Jev answer at or above `minConfidence`; fill the rest from the
 * heuristic. Returns the merged signals and which source won.
 */
export function mergeSignals(
  jev: JevSignals,
  fallback: RouteSignals,
  minConfidence: number,
): { signals: RouteSignals; source: RouteSource; confidence: RouteDecision["confidence"] } {
  const signals = { ...fallback } as Record<SignalKey, unknown>;
  const confidence: RouteDecision["confidence"] = {};
  let fromJev = 0;
  for (const key of SIGNAL_KEYS) {
    const answer = jev[key];
    if (!answer) continue;
    confidence[key] = Math.round(answer.confidence * 100) / 100;
    if (answer.confidence >= minConfidence) {
      signals[key] = answer.value;
      fromJev += 1;
    }
  }
  const source: RouteSource =
    fromJev === SIGNAL_KEYS.length ? "jev" : fromJev === 0 ? "heuristic" : "mixed";
  return { signals: signals as unknown as RouteSignals, source, confidence };
}

/**
 * Turn the five triage signals into a concrete plan: pace, effort, models,
 * reviewers, whether to queue the task, and which human gate it needs.
 * Also enforces two safety rules no classifier may skip.
 */
/** Frameworks whose verification means building and launching a native app. */
const NATIVE_FRAMEWORKS = new Set(["expo", "react-native"]);

/** The task is about shipping, so a release/archive build is part of the job. */
const RELEASE_RE =
  /\b(?:release|testflight|archive|app ?store|play store|submit|publish|publicar|lanzamiento)\b/i;

export function deriveDecision(
  raw: RouteSignals,
  preset: Preset,
  opts: { native?: boolean; task?: string } = {},
): Omit<RouteDecision, "source" | "confidence" | "ms"> {
  const notes: string[] = [];
  const s: RouteSignals = { ...raw };

  // Security-sensitive work never takes the lane that skips review.
  if (s.lane === "quick" && s.security) {
    s.lane = "standard";
    notes.push("security-sensitive → raised from quick to standard (quick skips review).");
  }
  // A "trivial" full-lane task is a contradiction; trust the lane.
  if (s.lane === "full" && (s.complexity === "trivial" || s.complexity === "small")) {
    s.complexity = "medium";
  }
  // The cheapest model only for the lightest work.
  if (s.implementerModel === "haiku" && (s.lane === "full" || s.complexity === "large")) {
    s.implementerModel = "sonnet";
    notes.push("haiku is too light for this lane/complexity → sonnet.");
  }

  const pace = s.lane === "full" ? "thorough" : s.lane === "standard" ? "balanced" : "fast";
  const effort = s.complexity === "large" ? "high" : s.complexity === "medium" ? "medium" : "low";

  let reviewerModel: ImplementerModel | null = null;
  const reviewers: ReviewerRole[] = [];
  if (s.lane !== "quick") {
    reviewers.push("reviewer");
    reviewerModel = s.lane === "full" && s.complexity === "large" ? "opus" : "sonnet";
    if (s.security) reviewers.push("security-reviewer");
    if (s.ui && s.lane !== "chore") reviewers.push("design-reviewer");
  }

  const humanGate: RouteDecision["humanGate"] =
    preset !== "sdd" || s.lane === "quick" || s.lane === "chore"
      ? "none"
      : s.lane === "standard"
        ? "plan"
        : "discovery+spec";

  // Verification proportional to the lane: only `full` work runs the whole
  // e2e suite; native apps get one build per platform outside `full`.
  const native = Boolean(opts.native);
  const verification: RouteDecision["verification"] = {
    e2e: s.lane === "quick" ? "none" : s.lane === "full" ? "full" : "smoke",
    nativeBuilds: !native || s.lane === "full" ? null : s.lane === "quick" ? 0 : 1,
    release: RELEASE_RE.test(opts.task ?? ""),
  };
  if (s.lane === "chore" && native) {
    notes.push(
      "native upgrade: keep it ONE feature (bump + fixes + verification) — every split costs another native build and review.",
    );
  }

  return {
    ...s,
    pace,
    effort,
    models: { implementer: s.implementerModel, reviewer: reviewerModel, explorer: "haiku" },
    reviewers,
    queue: s.lane !== "quick",
    humanGate,
    verification,
    notes,
  };
}

/** Triage a task: Jev when configured and reachable, the keyword heuristic otherwise. */
export async function routeTask(task: string, opts: RouteTaskOptions): Promise<RouteDecision> {
  const started = Date.now();
  const router = opts.router ?? RouterSchema.parse({});
  const provider = opts.provider ?? router.provider;
  const env = opts.env ?? process.env;
  const apiKey = provider === "heuristic" ? null : resolveJevKey(env, opts.home);
  const fallback = heuristicSignals(task);
  const notes: string[] = [];

  let merged: ReturnType<typeof mergeSignals> = {
    signals: fallback,
    source: "heuristic",
    confidence: {},
  };

  if (provider !== "heuristic") {
    if (!apiKey) {
      notes.push(
        provider === "jev"
          ? `router.provider is "jev" but ${JEV_KEY_ENV} is not set — used the heuristic.`
          : `Jev not configured (set ${JEV_KEY_ENV}) — used the heuristic.`,
      );
    } else {
      try {
        const jev = await askJev(task, opts.context, {
          apiKey,
          router,
          fetchImpl: opts.fetchImpl,
        });
        merged = mergeSignals(jev, fallback, router.minConfidence);
        if (merged.source !== "jev") {
          const weak = SIGNAL_KEYS.filter(
            (k) => (merged.confidence[k] ?? 0) < router.minConfidence,
          );
          notes.push(
            `Jev was unsure about ${weak.join(", ")} (< ${router.minConfidence}) — heuristic used there.`,
          );
        }
      } catch (err) {
        notes.push(`Jev unavailable (${(err as Error).message}) — used the heuristic.`);
      }
    }
  }

  const decision = deriveDecision(merged.signals, opts.context.preset, {
    native: opts.context.frameworks.some((f) => NATIVE_FRAMEWORKS.has(f)),
    task,
  });
  return {
    ...decision,
    notes: [...notes, ...decision.notes],
    source: merged.source,
    confidence: merged.confidence,
    ms: Date.now() - started,
  };
}
