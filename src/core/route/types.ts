import type { Lane, Preset } from "../config/schema";

export const COMPLEXITIES = ["trivial", "small", "medium", "large"] as const;
export const IMPLEMENTER_MODELS = ["haiku", "sonnet", "opus"] as const;

export type Complexity = (typeof COMPLEXITIES)[number];
export type ImplementerModel = (typeof IMPLEMENTER_MODELS)[number];
export type Pace = "fast" | "balanced" | "thorough";
export type ReviewerRole = "reviewer" | "security-reviewer" | "design-reviewer";
export type RouteSource = "jev" | "heuristic" | "mixed";

/** What triage decides about a task; everything else in a decision is derived from it. */
export interface RouteSignals {
  lane: Lane;
  complexity: Complexity;
  implementerModel: ImplementerModel;
  /** Touches auth, secrets, payments, permissions, input handling, … */
  security: boolean;
  /** Touches UI, components, styles, layout, copy, animation. */
  ui: boolean;
}

export type SignalKey = keyof RouteSignals;

/**
 * How much verification the task gets. Native builds and e2e suites dominate
 * wall time on mobile projects (a single iOS build is minutes), so the budget is
 * explicit and the implementer reports what it actually ran.
 */
export interface VerificationBudget {
  /** none = gate only; smoke = the e2e flows covering what changed; full = the whole suite. */
  e2e: "none" | "smoke" | "full";
  /** Native app builds per platform for the whole task; null = not a native app, or no cap. */
  nativeBuilds: number | null;
  /** Release/archive builds — only when the task is about shipping. */
  release: boolean;
}

/** A full routing recommendation for the leader. Advisory: the leader may override it. */
export interface RouteDecision extends RouteSignals {
  pace: Pace;
  effort: "low" | "medium" | "high";
  models: {
    implementer: ImplementerModel;
    /** Null when the lane runs no reviewer. */
    reviewer: ImplementerModel | null;
    explorer: "haiku";
  };
  /** Reviewers to launch up front; the leader still adds any the final diff calls for. */
  reviewers: ReviewerRole[];
  /** Register the task in feature_list.json (false = quick lane, untracked). */
  queue: boolean;
  /** The human checkpoint this lane needs before code is written. */
  humanGate: "none" | "plan" | "discovery+spec";
  verification: VerificationBudget;
  source: RouteSource;
  /** Jev's confidence per signal it answered (0–1). */
  confidence: Partial<Record<SignalKey, number>>;
  notes: string[];
  ms: number;
}

export interface RouteContext {
  preset: Preset;
  language: string;
  frameworks: string[];
}
