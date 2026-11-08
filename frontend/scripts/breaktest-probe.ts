import { loadDataset } from "../src/lib/engine/datasets";
import { facilityContexts } from "../src/lib/engine/model";
import { detect } from "../src/lib/engine/detect";
const warm = (process.argv[2] ?? "calm").split(",").filter(Boolean);
const reps = Number(process.argv[3] ?? 1);
const run = (id: string) => { const ds = loadDataset(id); const facs = facilityContexts(ds); return detect(ds, facs, ds.n - 1).events; };
for (let r = 0; r < reps; r++) for (const w of warm) run(w);
const res: string[] = [];
for (let k = 0; k < 5; k++) { const ev = run("test").filter(e => e.fc.fac.id === "S9_FACILITY_A" && e.category === "pump_failure"); res.push(String(ev[0]?.endIdx)); }
console.log("warm", warm.join(","), "x"+reps, "-> S9A endIdx over 5 runs:", res.join(" "));
