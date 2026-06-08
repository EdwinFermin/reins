import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pythonDetector } from "../../src/core/detect/python";

const here = path.dirname(fileURLToPath(import.meta.url));
const pythonFixture = path.join(here, "../fixtures/python-uv");

describe("python detector", () => {
  it("detects a uv project with pytest, ruff and frameworks", async () => {
    const profile = await pythonDetector.detect(pythonFixture);
    expect(profile).not.toBeNull();
    expect(profile?.language).toBe("python");
    expect(profile?.packageManager).toBe("uv");
    expect(profile?.commands.test?.value).toBe("uv run pytest");
    expect(profile?.commands.test?.confidence).toBe("high");
    expect(profile?.commands.lint?.value).toBe("uv run ruff check .");
    expect(profile?.commands.typecheck?.value).toBe("uv run mypy .");
    expect(profile?.frameworks).toContain("fastapi");
  });
});
