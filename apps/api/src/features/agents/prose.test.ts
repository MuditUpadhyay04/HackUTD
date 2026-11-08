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

describe("tidyProse: formatting is fixed, not rejected", () => {
  const ground: Grounding = { entities: ["S4_FACILITY_C"], labels: ["pump_failure"], categories: ["pump_failure"], data: { level: 92 } };
  test("line breaks, bullets and emphasis are removed; content is unchanged; angle brackets still fail", () => {
    expect(checkProse(ground, "**S4_FACILITY_C** pump failure:\n- tank 92% full\n- send a truck.")).toBe("S4_FACILITY_C pump failure: tank 92% full send a truck.");
    expect(() => checkProse(ground, "Tank <b>92%</b> full.")).toThrow("angle brackets");
  });
  test("a slight overrun is cut at the last full sentence; a large one still fails", () => {
    const s = "S4_FACILITY_C pump failure, tank 92% full. ";
    expect(checkProse(ground, s.repeat(3).trim(), { maxLength: 120 }).length).toBeLessThanOrEqual(120);
    expect(() => checkProse(ground, s.repeat(10), { maxLength: 120 })).toThrow("limit 120");
  });
});
