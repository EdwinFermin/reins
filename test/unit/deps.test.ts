import { describe, expect, it } from "vitest";
import {
  findDepIssues,
  normalizeFeatures,
  orderQueue,
  prematureFeatures,
} from "../../src/core/features/deps";

describe("normalizeFeatures", () => {
  it("coerces shapes and drops entries without a slug", () => {
    const nodes = normalizeFeatures([
      { slug: "a", state: "pending", dependsOn: ["b"] },
      { slug: "b" },
      { state: "pending" },
      "garbage",
    ]);
    expect(nodes).toEqual([
      { slug: "a", state: "pending", dependsOn: ["b"] },
      { slug: "b", state: "unknown", dependsOn: [] },
    ]);
  });
});

describe("findDepIssues", () => {
  it("reports nothing for a clean DAG", () => {
    const nodes = normalizeFeatures([
      { slug: "a", state: "done", dependsOn: [] },
      { slug: "b", state: "pending", dependsOn: ["a"] },
    ]);
    const { dangling, cycles } = findDepIssues(nodes);
    expect(dangling).toEqual([]);
    expect(cycles).toEqual([]);
  });

  it("flags a dependsOn pointing at an unknown feature", () => {
    const nodes = normalizeFeatures([{ slug: "a", state: "pending", dependsOn: ["ghost"] }]);
    const { dangling } = findDepIssues(nodes);
    expect(dangling).toEqual([{ slug: "a", dep: "ghost" }]);
  });

  it("detects a two-node cycle once", () => {
    const nodes = normalizeFeatures([
      { slug: "a", state: "pending", dependsOn: ["b"] },
      { slug: "b", state: "pending", dependsOn: ["a"] },
    ]);
    const { cycles } = findDepIssues(nodes);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b"]));
  });

  it("detects a self-cycle", () => {
    const nodes = normalizeFeatures([{ slug: "a", state: "pending", dependsOn: ["a"] }]);
    const { cycles } = findDepIssues(nodes);
    expect(cycles).toEqual([["a"]]);
  });
});

describe("prematureFeatures", () => {
  it("flags an in_progress feature whose dependency is not done", () => {
    const nodes = normalizeFeatures([
      { slug: "a", state: "pending", dependsOn: [] },
      { slug: "b", state: "in_progress", dependsOn: ["a"] },
    ]);
    expect(prematureFeatures(nodes).map((f) => f.slug)).toEqual(["b"]);
  });

  it("allows a gated feature once its dependency is done", () => {
    const nodes = normalizeFeatures([
      { slug: "a", state: "done", dependsOn: [] },
      { slug: "b", state: "in_progress", dependsOn: ["a"] },
    ]);
    expect(prematureFeatures(nodes)).toEqual([]);
  });

  it("ignores pending/analyzing features (only gates in_progress/done)", () => {
    const nodes = normalizeFeatures([
      { slug: "a", state: "pending", dependsOn: [] },
      { slug: "b", state: "analyzing", dependsOn: ["a"] },
    ]);
    expect(prematureFeatures(nodes)).toEqual([]);
  });

  it("ignores an approved feature whose dependency is not done", () => {
    const nodes = normalizeFeatures([
      { slug: "a", state: "pending", dependsOn: [] },
      { slug: "b", state: "approved", dependsOn: ["a"] },
    ]);
    expect(prematureFeatures(nodes)).toEqual([]);
  });
});

describe("orderQueue", () => {
  it("orders a pending dependency before its dependent", () => {
    const nodes = normalizeFeatures([
      { slug: "b", state: "pending", dependsOn: ["a"] },
      { slug: "a", state: "pending", dependsOn: [] },
    ]);
    expect(orderQueue(nodes)).toEqual(["a", "b"]);
  });

  it("puts features with all deps done ahead of blocked ones", () => {
    const nodes = normalizeFeatures([
      { slug: "blocked", state: "pending", dependsOn: ["pendingDep"] },
      { slug: "pendingDep", state: "pending", dependsOn: [] },
      { slug: "ready", state: "pending", dependsOn: ["finished"] },
      { slug: "finished", state: "done", dependsOn: [] },
    ]);
    const order = orderQueue(nodes);
    // `ready` (dep done) and `pendingDep` (no deps) are unblocked; `blocked`
    // depends on `pendingDep`, so it must come after it.
    expect(order.indexOf("pendingDep")).toBeLessThan(order.indexOf("blocked"));
    expect(order).not.toContain("finished"); // not pending
  });

  it("falls back to input order on a cycle without looping forever", () => {
    const nodes = normalizeFeatures([
      { slug: "a", state: "pending", dependsOn: ["b"] },
      { slug: "b", state: "pending", dependsOn: ["a"] },
    ]);
    expect(orderQueue(nodes).sort()).toEqual(["a", "b"]);
  });

  it("includes approved features in the queue", () => {
    const nodes = normalizeFeatures([
      { slug: "a", state: "approved", dependsOn: [] },
      { slug: "b", state: "pending", dependsOn: [] },
    ]);
    expect(orderQueue(nodes).sort()).toEqual(["a", "b"]);
  });

  it("puts an approved feature with deps done at the front", () => {
    const nodes = normalizeFeatures([
      { slug: "p", state: "pending", dependsOn: [] },
      { slug: "ap", state: "approved", dependsOn: ["d"] },
      { slug: "d", state: "done", dependsOn: [] },
    ]);
    expect(orderQueue(nodes)[0]).toBe("ap");
  });

  it("does not prefer an approved feature whose deps are not done", () => {
    const nodes = normalizeFeatures([
      { slug: "p", state: "pending", dependsOn: [] },
      { slug: "ap", state: "approved", dependsOn: ["p"] },
    ]);
    expect(orderQueue(nodes)).toEqual(["p", "ap"]);
  });
});
