import type { RunRecord, Snapshot } from "@hackutd/contracts";

/** Why an agent run started. `auto`: the open incidents changed at the newest moment; `manual`: someone asked. */
export interface AgentTrigger { kind: "auto" | "manual"; reason: string }

/** An incident ID without its run prefix ("pump_failure:S4_FACILITY_C:1793878500"): the same across a dataset's runs. */
export const incidentKey = (id: string) => id.slice(id.indexOf(":") + 1);

/** "S4_FACILITY_C" -> "S4 C", as the console writes it. */
const facility = (id: string) => { const m = /^([^_]+)_FACILITY_(.+)$/i.exec(id); return m ? `${m[1]!.toUpperCase()} ${m[2]}` : id; };
const label = (key: string) => { const [category = "", fac = ""] = key.split(":"); return `${facility(fac)} ${category.replace(/_/g, " ")}`; };
const list = (keys: string[]) => { const shown = keys.slice(0, 3).map(label).join(", "); return keys.length > 3 ? `${shown} and ${keys.length - 3} more` : shown; };

/** What changed between two sets of open incidents, in words; null when nothing did. */
export function describeChange(before: ReadonlySet<string>, after: ReadonlySet<string>): string | null {
  const opened = [...after].filter((k) => !before.has(k)).sort();
  const cleared = [...before].filter((k) => !after.has(k)).sort();
  const parts = [opened.length ? `${list(opened)} opened` : "", cleared.length ? `${list(cleared)} cleared` : ""].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

interface Lineage { at: number; ranKeys: Set<string> | null; busy: boolean; next?: { snapshot: Snapshot; keys: Set<string> }; task?: Promise<void> }

export interface AutoAgentsOptions {
  enabled: boolean;
  /** Starts the orchestrator; `done` settles when the agent run finishes (either way). */
  start(snapshot: Snapshot, trigger: AgentTrigger): Promise<{ id: string; done: Promise<unknown> }>;
  log?: (message: string) => void;
}

/**
 * Runs the agents by themselves when a run at the newest moment of a dataset becomes ready and its set of open
 * incidents differs from what the agents last saw. Advice only, like a manual run.
 *
 * - Looking back in time (a run earlier than the newest one seen) never triggers.
 * - One agent run at a time per dataset and runtime. Changes that arrive meanwhile collapse into one follow-up run
 *   on the newest snapshot, and none at all if the incidents went back to what the agents last saw.
 */
export class AutoAgents {
  private readonly lineages = new Map<string, Lineage>();
  constructor(private readonly o: AutoAgentsOptions) {}
  get enabled() { return this.o.enabled; }

  /** Returns the change it will act on, or null when the run doesn't trigger the agents. */
  onRunReady(run: Pick<RunRecord, "datasetId" | "requested" | "at">, snapshot: Snapshot): string | null {
    if (!this.o.enabled) return null;
    const id = `${run.datasetId}|${run.requested}`;
    let l = this.lineages.get(id);
    if (l && run.at < l.at) return null;
    if (!l) this.lineages.set(id, (l = { at: run.at, ranKeys: null, busy: false }));
    l.at = run.at;
    const keys = new Set(snapshot.alerts.filter((i) => i.status === "ongoing").map((i) => incidentKey(i.id)));
    l.next = { snapshot, keys };
    const reason = this.reason(l.ranKeys, keys);
    if (!l.busy) l.task = this.pump(l);
    return reason;
  }

  /** Resolves once no agent run started here is in flight (tests, shutdown). */
  async idle() {
    for (;;) {
      const busy = [...this.lineages.values()].filter((l) => l.busy || l.next).map((l) => l.task);
      if (!busy.length) return;
      await Promise.all(busy);
    }
  }

  private reason(ran: Set<string> | null, keys: Set<string>) {
    if (ran) return describeChange(ran, keys);
    return keys.size ? `First look at this dataset: ${list([...keys].sort())} open` : null;
  }

  private async pump(l: Lineage): Promise<void> {
    while (l.next) {
      const { snapshot, keys } = l.next;
      l.next = undefined;
      const reason = this.reason(l.ranKeys, keys);
      if (!reason) { l.ranKeys ??= keys; continue; }
      l.busy = true;
      l.ranKeys = keys;
      try {
        const r = await this.o.start(snapshot, { kind: "auto", reason });
        this.o.log?.(`[agents] auto run ${r.id} for ${snapshot.runId}: ${reason}`);
        await r.done;
      } catch (e) {
        this.o.log?.(`[agents] auto run for ${snapshot.runId} not started: ${e instanceof Error ? e.message : String(e)}`);
      } finally { l.busy = false; }
    }
  }
}
