import { describe, expect, test } from "bun:test";
import type { Snapshot } from "@hackutd/contracts";
import { factsFor, validateFinalization } from "./tools";

const plan = { id: "plan-s2-1", systemPlanId: "sys-plan-1", inputRevision: 7, kind: "trucks", label: "Trucks", cost: 1234.5, trucks: 3, feasibility: "validated", searchStatus: "best_feasible_found" };
const snapshot = { runId: "run", revision: 7, nowUnix: 1791467400, runtime: { scoresAvailable: true }, coverage: { expected: 15, received: 15, complete: true },
  recommendation: { state: "ready", inputRevision: 7, currentRevision: 7 }, history: [
    { id: "inc-old", status: "resolved", category: "pipeline_leak", facilityId: "S1_FAC_2", systemId: "S1", assetId: "PIPE-4", evidence: ["receive flow below send by 0.85 of nominal"] },
  ], alerts: [
    { id: "inc-1", status: "ongoing", category: "pump_failure", facilityId: "S2_FAC_3", systemId: "S2", assetId: "PUMP-7", planningStatus: "ready", evidence: ["pump flow 0 bpd for 4 steps", "tank level 72.4%"], plan },
  ] } as unknown as Snapshot;
const facts = factsFor(snapshot);
const ok = (handoff: string, planIds: string[] = []) => validateFinalization(facts, { handoff, evidenceIds: ["inc-1:evidence:0"], planIds });
const bad = (handoff: string, planIds: string[] = []) => expect(() => ok(handoff, planIds)).toThrow();

describe("grounded finalization check", () => {
  test("accepts ordinary prose that only uses snapshot names and numbers", () => {
    for (const handoff of [
      "Ongoing pump failure at S2_FAC_3 on PUMP-7 in system S2; failures like this need attention before the tank fills.",
      "The solver plan plan-s2-1 uses 3 trucks at a cost of 1,234.5; the operator should review it and confirm.",
      "Tank level is 72.4% and pump flow has been 0 bpd for 4 steps, so the countdown matters.",
      "Shift handoff: the pipeline leak at S1_FAC_2 is no longer active. Watch S2 closely.",
      "Receive flow was 85% of nominal at S1_FAC_2 earlier; FPGA scores are not shown here.",
    ]) expect(ok(handoff, ["plan-s2-1"]).handoff).toBe(handoff);
  });
  test("rejects numbers that are not in the facts", () => {
    bad("Review 99 trucks.");
    bad("The tank fills in 6 hours.");
    bad("Cost is $5,000.", ["plan-s2-1"]);
    bad("Tank level is 72.9%.");
  });
  test("rejects invented identifiers and names", () => {
    bad("Review Atlantis.");
    bad("Send crews to S9_FAC_1.");
    bad("Check PUMP-9 at S2_FAC_3.");
    bad("Watch the Riverside yard.");
  });
  test("rejects completed-action claims, ungrounded categories and uncited plans", () => {
    for (const verb of ["dispatched", "deployed", "sent", "completed", "repaired", "fixed", "resolved", "activated", "shut in", "shut-in", "shut down", "already shut in"]) bad(`The well was ${verb}.`);
    bad("The wells have been shut in at S2_FAC_3.");
    expect(ok("Review the shut-in option for S2_FAC_3 against the trucks option.").handoff).toContain("shut-in option");
    bad("Water quality degradation at S2_FAC_3 needs review.");
    bad("Review the available plan for S2_FAC_3.");
    expect(ok("Review the available plan for S2_FAC_3.", ["plan-s2-1"]).planIds).toEqual(["plan-s2-1"]);
  });
  test("keeps the shape limits and citation checks", () => {
    bad("x".repeat(1201));
    // layout is tidied, not rejected (prose.ts tidyProse): the content is unchanged
    expect(ok("Review S2_FAC_3.\nReview S2_FAC_3 again.").handoff).toBe("Review S2_FAC_3. Review S2_FAC_3 again.");
    expect(ok("Review `S2_FAC_3`.").handoff).toBe("Review S2_FAC_3.");
    bad("Review <S2_FAC_3>.");
    expect(() => validateFinalization(facts, { handoff: "Review S2_FAC_3.", evidenceIds: [], planIds: [] })).toThrow("Evidence citation required");
    expect(() => validateFinalization(facts, { handoff: "Review S2_FAC_3.", evidenceIds: ["inc-1:evidence:9"], planIds: [] })).toThrow("Invalid citation");
    expect(() => validateFinalization(facts, { handoff: "Review S2_FAC_3.", evidenceIds: ["inc-1:evidence:0"], planIds: [], extra: 1 })).toThrow();
  });
  test("error messages name what to fix", () => {
    expect(() => ok("Review 99 trucks.")).toThrow('Ungrounded number "99"');
    expect(() => ok("Review Atlantis.")).toThrow('Ungrounded name "Atlantis"');
  });
});
