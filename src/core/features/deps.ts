/**
 * Dependency-graph helpers over `feature_list.json` features.
 *
 * `dependsOn` is recorded by `reins add-feature` but was historically inert.
 * These helpers let both the verification gate (cycle / dangling / premature-start
 * checks) and `reins status` (dependency-ordered queue) honor it from one place.
 */

/** States whose dependencies must all be `done` before the feature may hold them. */
export const DEPENDENCY_GATED_STATES = new Set(["in_progress", "done"]);

export interface FeatureNode {
  slug: string;
  state: string;
  dependsOn: string[];
}

interface RawFeature {
  slug?: unknown;
  state?: unknown;
  dependsOn?: unknown;
}

/** Coerce a raw `features` array into clean nodes, dropping entries without a slug. */
export function normalizeFeatures(raw: unknown): FeatureNode[] {
  if (!Array.isArray(raw)) return [];
  const nodes: FeatureNode[] = [];
  for (const f of raw as RawFeature[]) {
    if (typeof f?.slug !== "string") continue;
    const dependsOn = Array.isArray(f.dependsOn)
      ? f.dependsOn.filter((d): d is string => typeof d === "string")
      : [];
    nodes.push({
      slug: f.slug,
      state: typeof f.state === "string" ? f.state : "unknown",
      dependsOn,
    });
  }
  return nodes;
}

export interface DepIssues {
  /** `dependsOn` entries that reference a slug not present in the feature list. */
  dangling: { slug: string; dep: string }[];
  /** Dependency cycles, each as the list of slugs that form the loop. */
  cycles: string[][];
}

/** Rotate a cycle to start at its smallest slug so equal cycles share a key. */
function canonicalCycleKey(cycle: string[]): string {
  let min = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i]! < cycle[min]!) min = i;
  }
  return [...cycle.slice(min), ...cycle.slice(0, min)].join(">");
}

/** Detect `dependsOn` references to unknown features and any dependency cycles. */
export function findDepIssues(features: FeatureNode[]): DepIssues {
  const bySlug = new Map(features.map((f) => [f.slug, f]));

  const dangling: { slug: string; dep: string }[] = [];
  for (const f of features) {
    for (const dep of f.dependsOn) {
      if (!bySlug.has(dep)) dangling.push({ slug: f.slug, dep });
    }
  }

  // DFS three-coloring over existing edges; a GRAY back-edge closes a cycle.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(features.map((f) => [f.slug, WHITE]));
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (slug: string): void => {
    color.set(slug, GRAY);
    stack.push(slug);
    for (const dep of bySlug.get(slug)?.dependsOn ?? []) {
      if (!bySlug.has(dep)) continue; // dangling, reported separately
      const c = color.get(dep);
      if (c === GRAY) {
        const cycle = stack.slice(stack.indexOf(dep));
        const key = canonicalCycleKey(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (c === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(slug, BLACK);
  };

  for (const f of features) {
    if (color.get(f.slug) === WHITE) visit(f.slug);
  }

  return { dangling, cycles };
}

/** True when every dependency of `feature` is in state `done`. */
export function dependenciesDone(feature: FeatureNode, bySlug: Map<string, FeatureNode>): boolean {
  return feature.dependsOn.every((dep) => bySlug.get(dep)?.state === "done");
}

/** Dependency-gated features that hold a gated state before their deps are `done`. */
export function prematureFeatures(features: FeatureNode[]): FeatureNode[] {
  const bySlug = new Map(features.map((f) => [f.slug, f]));
  return features.filter(
    (f) => DEPENDENCY_GATED_STATES.has(f.state) && !dependenciesDone(f, bySlug),
  );
}

/**
 * Pending slugs in a stable topological order: a feature appears after any
 * pending feature it depends on, with deps already `done` treated as satisfied.
 * Input order breaks ties; a cycle falls back to input order to keep progressing.
 */
export function orderPending(features: FeatureNode[]): string[] {
  const bySlug = new Map(features.map((f) => [f.slug, f]));
  const pending = features.filter((f) => f.state === "pending");
  const pendingSlugs = new Set(pending.map((f) => f.slug));

  const unmet = new Map<string, Set<string>>();
  for (const f of pending) {
    unmet.set(
      f.slug,
      new Set(f.dependsOn.filter((d) => pendingSlugs.has(d) && bySlug.get(d)?.state !== "done")),
    );
  }

  const order: string[] = [];
  const remaining = pending.map((f) => f.slug);
  while (remaining.length > 0) {
    const idx = remaining.findIndex((slug) => (unmet.get(slug)?.size ?? 0) === 0);
    const [slug] = remaining.splice(idx === -1 ? 0 : idx, 1);
    order.push(slug!);
    for (const deps of unmet.values()) deps.delete(slug!);
  }
  return order;
}
