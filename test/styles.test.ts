import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("The stylesheet", () => {
  // A brace left open makes browsers drop or misplace every rule after it
  // (seen from 0.38 to 0.46: an unclosed @media kept the rest for phones).
  it("closes every block it opens", async () => {
    const css = (await (await SELF.fetch("https://la-fabrique.test/styles.css")).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    for (const char of css) {
      if (char === "{") depth++;
      if (char === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
