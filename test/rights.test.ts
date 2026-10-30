import { describe, expect, it } from "vitest";
import { can } from "../src/rights";

describe("Rights per action", () => {
  it("follows the ladder: each role has the rights of the ones below", () => {
    expect(can(null, "report_defect")).toBe(true);
    expect(can(null, "validate")).toBe(false);
    expect(can("tester", "validate")).toBe(true);
    expect(can("tester", "request")).toBe(false);
    expect(can("product_engineer", "request")).toBe(true);
    expect(can("product_engineer", "launch_claude")).toBe(false);
    expect(can("tech_lead", "validate")).toBe(true);
    expect(can("tech_lead", "launch_claude")).toBe(true);
    expect(can("tech_lead", "go")).toBe(false);
    expect(can("super_admin", "go")).toBe(true);
  });
});
