import type { RouteDecision } from "./types";

const GATE_TEXT: Record<RouteDecision["humanGate"], string> = {
  none: "none — implement right away",
  plan: "one: approve specs/<slug>/plan.md",
  "discovery+spec": "two: validate discovery, then approve the spec",
};

const SOURCE_TEXT: Record<RouteDecision["source"], string> = {
  jev: "Jev",
  mixed: "Jev + heuristic",
  heuristic: "heuristic",
};

export function verifyText(v: RouteDecision["verification"]): string {
  const parts = [v.e2e === "none" ? "gate only" : `${v.e2e} e2e`];
  if (v.nativeBuilds !== null) parts.push(`≤${v.nativeBuilds} native build(s)/platform`);
  if (v.nativeBuilds !== null || v.release)
    parts.push(v.release ? "release build" : "no release build");
  return parts.join(" · ");
}

export function formatRoute(d: RouteDecision): string {
  const lines = [
    "",
    `Route — ${d.lane} lane (${d.pace}) · via ${SOURCE_TEXT[d.source]}`,
    `  Complexity:  ${d.complexity}`,
    `  Implementer: ${d.models.implementer} (effort ${d.effort})`,
    `  Reviewers:   ${
      d.reviewers.length ? `${d.reviewers.join(", ")} (${d.models.reviewer})` : "none — gate only"
    }`,
    `  Human gate:  ${GATE_TEXT[d.humanGate]}`,
    `  Verify:      ${verifyText(d.verification)}`,
    `  Queue:       ${
      d.queue
        ? `reins add-feature <slug> --lane ${d.lane}`
        : "not tracked — implement directly, then log one line in progress/history.md"
    }`,
  ];
  const conf = Object.entries(d.confidence);
  if (conf.length) {
    lines.push(
      `  Confidence:  ${conf.map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ")}`,
    );
  }
  for (const note of d.notes) lines.push(`  Note: ${note}`);
  lines.push("");
  return lines.join("\n");
}
