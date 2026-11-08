import { describe, expect, test } from "bun:test";
import type { Snapshot } from "@hackutd/contracts";
import { AutoAgents, describeChange, incidentKey, type AgentTrigger } from "./auto";

const PUMP_C = "pump_failure:S4_FACILITY_C:1793878500";
const LEAK_B = "pipeline_leak:S5_FACILITY_B:1793870000";
const snap = (runId: string, ...keys: string[]) =>
  ({ runId, alerts: keys.map((k) => ({ id: `${runId}:${k}`, status: "ongoing" })) }) as unknown as Snapshot;
const run = (at: number) => ({ datasetId: "d1", requested: "auto" as const, at });

function harness(enabled = true) {
  const started: { runId: string; trigger: AgentTrigger; finish: () => void }[] = [];
  const auto = new AutoAgents({
    enabled,
    start: async (snapshot, trigger) => {
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      started.push({ runId: snapshot.runId, trigger, finish });
      return { id: `agents-${started.length}`, done };
    },
  });
  return { auto, started };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("auto agents", () => {
  test("incident keys drop the run prefix; changes read like the console", () => {
    expect(incidentKey(`run-1:${PUMP_C}`)).toBe(PUMP_C);
    expect(describeChange(new Set([LEAK_B]), new Set([PUMP_C]))).toBe("S4 C pump failure opened; S5 B pipeline leak cleared");
    expect(describeChange(new Set([PUMP_C]), new Set([PUMP_C]))).toBeNull();
  });

  test("runs on a first look with open incidents and on each change at the newest moment, never when looking back", async () => {
    const { auto, started } = harness();
    expect(auto.onRunReady(run(1000), snap("r1", PUMP_C))).toContain("First look");
    await tick(); started[0]!.finish(); await auto.idle();
    expect(auto.onRunReady(run(1300), snap("r2", PUMP_C))).toBeNull(); // same incidents
    expect(auto.onRunReady(run(700), snap("r0", LEAK_B))).toBeNull(); // the past
    expect(auto.onRunReady(run(1600), snap("r3", PUMP_C, LEAK_B))).toBe("S5 B pipeline leak opened");
    await tick(); started[1]!.finish(); await auto.idle();
    expect(started.map((s) => [s.runId, s.trigger.kind])).toEqual([["r1", "auto"], ["r3", "auto"]]);
  });

  test("a quiet start waits for the first incident", async () => {
    const { auto, started } = harness();
    expect(auto.onRunReady(run(1000), snap("r1"))).toBeNull();
    expect(auto.onRunReady(run(1300), snap("r2", PUMP_C))).toBe("S4 C pump failure opened");
    await tick(); started[0]!.finish(); await auto.idle();
    expect(started).toHaveLength(1);
  });

  test("changes during a run collapse into one follow-up on the newest snapshot, or none if they reverted", async () => {
    const { auto, started } = harness();
    auto.onRunReady(run(1000), snap("r1", PUMP_C));
    await tick();
    auto.onRunReady(run(1300), snap("r2", PUMP_C, LEAK_B));
    auto.onRunReady(run(1600), snap("r3", LEAK_B));
    expect(started).toHaveLength(1);
    started[0]!.finish(); await tick();
    expect(started.map((s) => s.runId)).toEqual(["r1", "r3"]);
    expect(started[1]!.trigger.reason).toBe("S5 B pipeline leak opened; S4 C pump failure cleared");
    auto.onRunReady(run(1900), snap("r4", PUMP_C));
    auto.onRunReady(run(2200), snap("r5", LEAK_B)); // back to what the agents last saw
    started[1]!.finish(); await auto.idle();
    expect(started).toHaveLength(2);
  });

  test("off when disabled", () => {
    const { auto, started } = harness(false);
    expect(auto.onRunReady(run(1000), snap("r1", PUMP_C))).toBeNull();
    expect(started).toHaveLength(0);
  });
});
