import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RouterSchema } from "../../src/core/config/schema";
import { heuristicSignals } from "../../src/core/route/heuristic";
import { resolveJevKey } from "../../src/core/route/jev";
import { deriveDecision, mergeSignals, routeTask } from "../../src/core/route/run";
import type { RouteContext, RouteSignals } from "../../src/core/route/types";

const sdd: RouteContext = { preset: "sdd", language: "node", frameworks: ["expo"] };
const noRc = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "reins-home-"));

/** A fetch double that records the request and answers like Jev. */
function fakeJev(answers: Record<string, { choice: string; confidence: number }>, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = async (
    url: string,
    init: { headers: Record<string, string>; body: string },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status < 300, status, json: async () => ({ answers }) };
  };
  return { fetchImpl, calls };
}

const confident = {
  lane: { choice: "chore", confidence: 0.97 },
  complexity: { choice: "medium", confidence: 0.9 },
  implementerModel: { choice: "sonnet", confidence: 0.88 },
  security: { choice: "no", confidence: 0.95 },
  ui: { choice: "no", confidence: 0.92 },
};

describe("heuristic triage", () => {
  it.each([
    ["upgrade Expo to SDK 55", "chore"],
    ["actualizar expo a la SDK 55", "chore"],
    ["bump all dependencies", "chore"],
    ["cambia el color del botón de guardar", "quick"],
    ["fix the typo in the README", "quick"],
    ["add CSV export to the reports page", "standard"],
    ["implement OAuth login with Google and refresh tokens", "full"],
  ])("%s → %s", (task, lane) => {
    expect(heuristicSignals(task).lane).toBe(lane);
  });

  it("flags security- and UI-touching tasks", () => {
    expect(heuristicSignals("rotate the API keys used by the webhook").security).toBe(true);
    expect(heuristicSignals("redesign the settings screen").ui).toBe(true);
    expect(heuristicSignals("speed up the CSV parser").security).toBe(false);
  });
});

describe("deriveDecision", () => {
  const base: RouteSignals = {
    lane: "standard",
    complexity: "small",
    implementerModel: "sonnet",
    security: false,
    ui: false,
  };

  it("never lets security-sensitive work skip review", () => {
    const d = deriveDecision({ ...base, lane: "quick", security: true }, "sdd");
    expect(d.lane).toBe("standard");
    expect(d.reviewers).toEqual(["reviewer", "security-reviewer"]);
    expect(d.notes.join(" ")).toContain("raised from quick to standard");
  });

  it("runs no reviewer and queues nothing for a quick task", () => {
    const d = deriveDecision({ ...base, lane: "quick", complexity: "trivial" }, "sdd");
    expect(d).toMatchObject({ reviewers: [], queue: false, humanGate: "none", pace: "fast" });
    expect(d.models.reviewer).toBeNull();
  });

  it("keeps haiku off heavy work", () => {
    const d = deriveDecision({ ...base, lane: "full", implementerModel: "haiku" }, "sdd");
    expect(d.models.implementer).toBe("sonnet");
    expect(d.complexity).toBe("medium"); // a "small" full-lane task is a contradiction
  });

  it("maps lanes to human gates per preset", () => {
    expect(deriveDecision({ ...base, lane: "standard" }, "sdd").humanGate).toBe("plan");
    expect(deriveDecision({ ...base, lane: "full" }, "sdd").humanGate).toBe("discovery+spec");
    expect(deriveDecision({ ...base, lane: "chore" }, "sdd").humanGate).toBe("none");
    expect(deriveDecision({ ...base, lane: "full" }, "lite").humanGate).toBe("none");
  });

  it("skips the design reviewer on chores and adds it for UI work", () => {
    expect(deriveDecision({ ...base, ui: true }, "sdd").reviewers).toContain("design-reviewer");
    expect(deriveDecision({ ...base, lane: "chore", ui: true }, "sdd").reviewers).toEqual([
      "reviewer",
    ]);
  });
});

describe("mergeSignals", () => {
  it("keeps confident Jev answers and falls back field by field", () => {
    const fallback = heuristicSignals("add CSV export");
    const merged = mergeSignals(
      {
        lane: { value: "full", confidence: 0.9 },
        complexity: { value: "large", confidence: 0.3 },
      },
      fallback,
      0.6,
    );
    expect(merged.signals.lane).toBe("full");
    expect(merged.signals.complexity).toBe(fallback.complexity);
    expect(merged.source).toBe("mixed");
    expect(merged.confidence).toEqual({ lane: 0.9, complexity: 0.3 });
  });
});

describe("routeTask", () => {
  it("asks Jev once with every question and uses its answers", async () => {
    const { fetchImpl, calls } = fakeJev(confident);
    const d = await routeTask("upgrade Expo to SDK 55", {
      context: sdd,
      env: { TYPESAFE_API_KEY: "test-key" },
      home: await noRc(),
      fetchImpl,
    });
    expect(d.source).toBe("jev");
    expect(d).toMatchObject({ lane: "chore", complexity: "medium", reviewers: ["reviewer"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.headers.Authorization).toBe("Bearer test-key");
    expect(calls[0]!.body.model).toBe("jev-latest");
    expect(Object.keys(calls[0]!.body.questions).sort()).toEqual(
      ["complexity", "implementerModel", "lane", "security", "ui"].sort(),
    );
    expect(calls[0]!.body.state).toContain("upgrade Expo to SDK 55");
    expect(calls[0]!.body.state).toContain("expo");
  });

  it("falls back to the heuristic when Jev is unsure", async () => {
    const { fetchImpl } = fakeJev({ ...confident, lane: { choice: "full", confidence: 0.4 } });
    const d = await routeTask("upgrade Expo to SDK 55", {
      context: sdd,
      env: { TYPESAFE_API_KEY: "k" },
      home: await noRc(),
      fetchImpl,
    });
    expect(d.lane).toBe("chore"); // heuristic, not Jev's unsure "full"
    expect(d.source).toBe("mixed");
    expect(d.notes.join(" ")).toContain("unsure about lane");
  });

  it("ignores answers outside the offered options", async () => {
    const { fetchImpl } = fakeJev({ ...confident, lane: { choice: "yolo", confidence: 0.99 } });
    const d = await routeTask("upgrade Expo to SDK 55", {
      context: sdd,
      env: { TYPESAFE_API_KEY: "k" },
      home: await noRc(),
      fetchImpl,
    });
    expect(d.lane).toBe("chore");
  });

  it("falls back to the heuristic when Jev errors, without leaking the key", async () => {
    const { fetchImpl } = fakeJev(confident, 500);
    const d = await routeTask("upgrade Expo to SDK 55", {
      context: sdd,
      env: { TYPESAFE_API_KEY: "secret-key" },
      home: await noRc(),
      fetchImpl,
    });
    expect(d.source).toBe("heuristic");
    expect(d.notes.join(" ")).toContain("Jev unavailable (HTTP 500)");
    expect(JSON.stringify(d)).not.toContain("secret-key");
  });

  it("uses the heuristic without a key, and never calls Jev for provider=heuristic", async () => {
    const { fetchImpl, calls } = fakeJev(confident);
    const noKey = await routeTask("upgrade Expo", {
      context: sdd,
      env: {},
      home: await noRc(),
      fetchImpl,
    });
    expect(noKey.notes.join(" ")).toContain("set TYPESAFE_API_KEY");
    await routeTask("upgrade Expo", {
      context: sdd,
      env: { TYPESAFE_API_KEY: "k" },
      provider: "heuristic",
      fetchImpl,
    });
    expect(calls).toHaveLength(0);
  });

  it("honors the router config (URL, model)", async () => {
    const { fetchImpl, calls } = fakeJev(confident);
    await routeTask("upgrade Expo", {
      context: sdd,
      router: RouterSchema.parse({ url: "https://jev.example/v1", model: "jev-test" }),
      env: { TYPESAFE_API_KEY: "k" },
      home: await noRc(),
      fetchImpl,
    });
    expect(calls[0]!.url).toBe("https://jev.example/v1");
    expect(calls[0]!.body.model).toBe("jev-test");
  });
});

describe("resolveJevKey", () => {
  it("prefers the environment, then a literal export in a shell rc file", async () => {
    const home = await noRc();
    await writeFile(
      path.join(home, ".zshrc"),
      "export PATH=/x:$PATH\nexport TYPESAFE_API_KEY='old'\nexport TYPESAFE_API_KEY=\"rc-key\"\n",
    );
    expect(resolveJevKey({ TYPESAFE_API_KEY: "env-key" }, home)).toBe("env-key");
    expect(resolveJevKey({}, home)).toBe("rc-key"); // last assignment wins
  });

  it("ignores values that need shell expansion", async () => {
    const home = await noRc();
    await writeFile(path.join(home, ".bashrc"), "export TYPESAFE_API_KEY=$(pass show jev)\n");
    expect(resolveJevKey({}, home)).toBeNull();
  });
});

describe("verification budget", () => {
  const base: RouteSignals = {
    lane: "chore",
    complexity: "medium",
    implementerModel: "sonnet",
    security: false,
    ui: false,
  };

  it("caps native builds and runs smoke e2e for a native chore", () => {
    const d = deriveDecision(base, "sdd", { native: true, task: "upgrade Expo to SDK 57" });
    expect(d.verification).toEqual({ e2e: "smoke", nativeBuilds: 1, release: false });
    expect(d.notes.join(" ")).toContain("keep it ONE feature");
  });

  it("allows a release build only when the task is about shipping", () => {
    const d = deriveDecision(base, "sdd", {
      native: true,
      task: "bump build number and upload to TestFlight",
    });
    expect(d.verification.release).toBe(true);
  });

  it("has no native cap for web projects or full-lane work, and no e2e for quick", () => {
    expect(deriveDecision(base, "sdd", { native: false }).verification.nativeBuilds).toBeNull();
    expect(deriveDecision({ ...base, lane: "full" }, "sdd", { native: true }).verification).toEqual(
      {
        e2e: "full",
        nativeBuilds: null,
        release: false,
      },
    );
    expect(
      deriveDecision({ ...base, lane: "quick", complexity: "trivial" }, "sdd", { native: true })
        .verification,
    ).toEqual({ e2e: "none", nativeBuilds: 0, release: false });
  });

  it("derives native-ness from the project's frameworks", async () => {
    const d = await routeTask("upgrade Expo to SDK 57", { context: sdd, provider: "heuristic" });
    expect(d.verification.nativeBuilds).toBe(1);
    const web = await routeTask("upgrade Next to 16", {
      context: { preset: "lite", language: "node", frameworks: ["next"] },
      provider: "heuristic",
    });
    expect(web.verification.nativeBuilds).toBeNull();
  });
});
