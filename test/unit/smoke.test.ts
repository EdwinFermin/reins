import { describe, expect, it } from "vitest";
import { REINS_VERSION } from "../../src/index";

describe("reins package", () => {
  it("exposes a semver-looking version string", () => {
    expect(typeof REINS_VERSION).toBe("string");
    expect(REINS_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
