import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodeDetector } from "../../src/core/detect/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeFixture = path.join(here, "../fixtures/node-vitest");
const pythonFixture = path.join(here, "../fixtures/python-uv");

describe("node detector", () => {
  it("detects a pnpm project with scripts and frameworks", async () => {
    const profile = await nodeDetector.detect(nodeFixture);
    expect(profile).not.toBeNull();
    expect(profile?.language).toBe("node");
    expect(profile?.packageManager).toBe("pnpm");
    expect(profile?.commands.test?.value).toBe("pnpm test");
    expect(profile?.commands.build?.value).toBe("pnpm run build");
    expect(profile?.commands.lint?.value).toBe("pnpm run lint");
    expect(profile?.commands.typecheck?.value).toBe("npx tsc --noEmit");
    expect(profile?.frameworks).toContain("next");
  });

  it("returns null when there is no package.json", async () => {
    expect(await nodeDetector.detect(pythonFixture)).toBeNull();
  });
});
