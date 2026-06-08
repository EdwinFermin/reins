import { describe, expect, it } from "vitest";
import { renderString } from "../../src/core/render/engine";

describe("eta render", () => {
  it("interpolates data via `it`", () => {
    const out = renderString("Hello <%= it.name %> (<%= it.preset %>)", {
      name: "reins",
      preset: "sdd",
    });
    expect(out).toBe("Hello reins (sdd)");
  });

  it("supports conditionals without HTML escaping", () => {
    const tpl = "<% if (it.isSdd) { %>SDD & specs<% } else { %>LITE<% } %>";
    expect(renderString(tpl, { isSdd: true })).toBe("SDD & specs");
    expect(renderString(tpl, { isSdd: false })).toBe("LITE");
  });
});
