"""Cross-check a golden set against the FPGA team's reference model (branch FPGA, FPGA/model/eog_ref.py).

    python -m hutd_ml.xcheck --fpga-model <path to FPGA/model> --golden artifacts/v2/golden/g2 [--zero-k4] [--show 5]

Feeds the golden set's GLOBAL / CONFIG / weights / DATA records through `eog_ref.Engine` and compares every RESULT
with expected_results.bin (from features_int.py) field by field. Prints mismatch counts per field, the reason bits
that differ, and the first few mismatching records. Both models should agree bit for bit; any difference is a spec
question for whichever side is wrong.

--zero-k4 zeroes GLOBAL bytes 20-23 before handing them to eog_ref (spec v1 reads bytes 20-21 as SHUTIN_WATER_MAX,
while the FPGA response puts per-class K there).
"""
import argparse
import collections
import json
import sys
from pathlib import Path

import numpy as np

from . import model_int, wire


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fpga-model", required=True)
    ap.add_argument("--golden", required=True)
    ap.add_argument("--zero-k4", action="store_true")
    ap.add_argument("--remap-lohi", action="store_true",
                    help="re-order CONFIG lo[]/hi[] from present-bit order (A14) to eog_ref's DATA-field order")
    ap.add_argument("--show", type=int, default=5)
    a = ap.parse_args(argv)
    sys.path.insert(0, str(Path(a.fpga_model).resolve()))
    import eog_ref  # noqa: E402

    g = Path(a.golden)
    man = json.loads((g / "manifest.json").read_text())
    glb = bytearray((g / "global_config.bin").read_bytes())
    if a.zero_k4:
        glb[20:24] = b"\0\0\0\0"
    fac = np.fromfile(g / "facility_config.bin", dtype=wire.FAC_CONFIG_DTYPE)
    data = np.fromfile(g / "data.bin", dtype=wire.DATA_DTYPE)
    exp = np.fromfile(g / "expected_results.bin", dtype=wire.RESULT_DTYPE)

    eng = eog_ref.Engine()
    if a.remap_lohi:  # ours: inflow, level, pump_status, pump_flow, discharge, receive, pipeline
        fac = fac.copy()  # eog_ref: inflow, level, pump_flow, receive, discharge, pipeline, (unused)
        order = [0, 1, 3, 5, 4, 6, 2]
        fac["lo"], fac["hi"] = fac["lo"][:, order], fac["hi"][:, order]
    eng.configure(bytes(glb), {int(r["fac_id"]): r.tobytes() for r in fac})
    if (g / "weights.bin").exists():
        m = model_int.unpack_blob((g / "weights.bin").read_bytes())
        img = eog_ref.encode_weights(m["w_q"].tolist(), m["b_q"].tolist(), int(m["s_out"]), int(man["weights_version"]))
        eng.load_weights(img)
        eng.swap()
    eng.heartbeat()

    got = np.zeros(len(data), dtype=wire.RESULT_DTYPE)
    alerts = []
    for i, r in enumerate(data):
        o = eng.push(r.tobytes())
        got[i] = np.frombuffer(o["result_bytes"], dtype=wire.RESULT_DTYPE)[0]
        alerts += o["alert_dicts"]

    fields = ["fac_id", "status", "since_reset", "ts_unix", "reason", "logits", "rules", "weights_ver", "countdown",
              "result_no"]
    counts, examples = collections.Counter(), []
    rbits = collections.Counter()
    for i in range(len(data)):
        bad = [f for f in fields if not np.array_equal(exp[i][f], got[i][f])]
        for f in bad:
            counts[f] += 1
        if "reason" in bad:
            x = int(exp[i]["reason"]) ^ int(got[i]["reason"])
            for b in range(16):
                if x >> b & 1:
                    rbits[b] += 1
        if bad and len(examples) < a.show:
            examples.append((i, {f: (exp[i][f].tolist(), got[i][f].tolist()) for f in bad}))
    print(f"{g}: {len(data)} records; mismatching records per field (ours vs eog_ref): {dict(counts) or 'none'}")
    if rbits:
        print("reason bits that differ (bit: records):", dict(sorted(rbits.items())))
    for i, d in examples:
        print(f"  record {i}: " + "; ".join(f"{f} ours {e} theirs {t}" for f, (e, t) in d.items()))
    exp_al = json.loads((g / "expected_alerts.json").read_text())
    key = ("fac_id", "kind", "source", "ts_unix", "result_no", "rules", "classes", "countdown_p10")
    theirs_key = ("FAC_ID", "KIND", "SOURCE", "TS", "RESULT_NO", "RULES", "CLASSES", "CD_P10")
    ours_t = [tuple(int(x[k]) for k in key) for x in exp_al]
    theirs_t = [tuple(int(x[k]) for k in theirs_key) for x in alerts]
    same = sum(o == t for o, t in zip(ours_t, theirs_t))
    print(f"alerts: ours {len(ours_t)}, eog_ref {len(theirs_t)}, identical in order {same}")
    for o, t in [(o, t) for o, t in zip(ours_t, theirs_t) if o != t][:a.show]:
        print("  alert ours", dict(zip(key, o)), "theirs", dict(zip(key, t)))
    sys.exit(0 if not counts and ours_t == theirs_t else 1)


if __name__ == "__main__":
    main()
