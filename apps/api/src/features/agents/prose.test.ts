import { describe, expect, test } from "bun:test";
import { checkProse, lintProse, type Grounding } from "./prose";

const ground: Grounding = { entities: ["S4_FACILITY_C", "S4", "option:abc123"], labels: ["pump_failure", "trucks"], categories: ["pump_failure"],
  data: { countdown: "2h47m", levelPct: 92, cost: 4439.66, label: "Truck haul" } };

describe("shared prose grounding", () => {
  test("accepts tokens and numbers that appear in the scoped data", () => {
    expect(checkProse(ground, "S4_FACILITY_C pump failure: tank 92% full, about 2h47m to the limit; the Truck haul option costs $4,439.66.")).toContain("2h47m");
  });
  test("rejects values, names and claims outside the scope", () => {
    expect(() => checkProse(ground, "Tank is 95% full.")).toThrow('Ungrounded number "95%"');
    expect(() => checkProse(ground, "About 3h10m left.")).toThrow('Ungrounded identifier "3h10m"');
    expect(() => checkProse(ground, "Call the Midland office.")).toThrow('Ungrounded name "Midland"');
    expect(() => checkProse(ground, "The plan was approved.")).toThrow("Completed-action claim");
    expect(() => checkProse(ground, "A leak is likely.")).toThrow("Ungrounded incident category");
    expect(() => checkProse(ground, "x".repeat(50), { maxLength: 40, field: "note" })).toThrow("Invalid note prose");
    expect(() => checkProse(ground, `S4 plan option:${"a".repeat(40)} ${"x".repeat(40)}`, { maxLength: 40 })).toThrow("IDs go in the ID fields");
  });
  test("a hyphenated compound is a description, not a completed action", () => {
    expect(checkProse(ground, "The Truck haul option is the solver-approved choice.")).toContain("solver-approved");
    expect(() => checkProse(ground, "The plan approved by S4.")).toThrow("Completed-action claim");
  });
  test("lint counts raw unix times, long IDs and snake_case labels without rejecting", () => {
    expect(lintProse("Since 1791450000 use option:aca9d5291644598d (do_nothing) for pump_failure.")).toEqual({ rawTimes: 1, ids: 1, snakeLabels: 2, chars: 75 });
    expect(lintProse("Pump down at S4 C, 2h47m to the limit.")).toEqual({ rawTimes: 0, ids: 0, snakeLabels: 0, chars: 38 });
  });
});
