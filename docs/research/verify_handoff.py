"""Independently verify saved input fixtures against raw reference readings.

Usage: python3 docs/research/verify_handoff.py /path/to/reference
Requires numpy and pandas. Does not import or reuse the audit preprocessor.
"""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd


def main():
    here = Path(__file__).resolve().parent
    root = Path(sys.argv[1]) / "history/full_week"
    contract = json.loads((here / "model-input-v1.json").read_text())
    golden = json.loads((here / "fixtures/golden_vectors.json").read_text())
    network = json.loads((root / "network.json").read_text())
    events = json.loads((root / "answer_key.json").read_text())
    readings = pd.read_csv(root / "telemetry.csv").set_index(["ts_unix", "asset_id", "metric"]).value
    earliest = readings.index.get_level_values("ts_unix").min()
    assert golden["feature_order"] == contract["channels"]
    assert golden["target_order"] == contract["output_targets"]
    assert contract["reference_shape"] == [1, 12, 96]
    assert contract["transport"]["scale"] == 1 / 16384
    assert contract["transport"]["zero_point"] == 0

    for vector in golden["vectors"]:
        system, facility = next((s, f) for s in network["systems"] for f in s["facilities"]
                                if f["id"] == vector["facility"])
        b = sum(w["baseline_water_bpd"] for w in facility["wells"])
        capacity = facility["tank"]["capacity_bbl"]
        rated = facility["pump"]["max_flow_bpd"]
        pressure = system["disposal_site"]["pressure_psi"]
        newest = vector["ts_unix"]
        rows = []
        for t in range(newest - 95 * 300, newest + 1, 300):
            def get(asset, metric):
                return float(readings.loc[(t, asset, metric)])

            inflow = get(facility["id"], "inflow_bpd")
            pump = get(facility["pump"]["id"], "flow_bpd")
            receive = get(facility["pipeline"]["id"], "receive_flow_bpd")
            level = get(facility["tank"]["id"], "level_pct")
            status = get(facility["pump"]["id"], "status")
            well_status = [get(w["id"], "status") for w in facility["wells"]]
            water = [get(w["id"], "water_bpd") for w in facility["wells"]]
            previous = float(readings.loc[(t - 300, facility["tank"]["id"], "level_pct")]) if t > earliest else level
            rows.append([
                inflow / b, pump / rated, receive / rated, (pump - receive) / rated,
                level / 100, (get(facility["pump"]["id"], "discharge_psi") - pressure) / 150,
                (get(facility["pipeline"]["id"], "pressure_psi") - pressure) / 50,
                int(status == 1), int(status == 2), sum(well_status) / len(well_status),
                sum(water) / b, (level - previous) * capacity * 288 / (100 * b),
            ])
        x = np.array(rows, dtype=np.float64).T
        q = np.rint(x * 16384).astype(np.int64)
        assert q.min() >= -32768 and q.max() <= 32767, "Unexpected input saturation"
        payload = (here / "fixtures" / vector["payload_file"]).read_bytes()
        assert len(payload) == vector["payload_bytes"] == contract["transport"]["payload_bytes"]
        assert hashlib.sha256(payload).hexdigest() == vector["payload_sha256"]
        np.testing.assert_array_equal(np.frombuffer(payload, dtype="<i2").reshape(12, 96), q)
        np.testing.assert_allclose(x[:, -1], vector["latest_float_features"], atol=1e-12, rtol=0)
        np.testing.assert_array_equal(q[:, -1], vector["latest_quantized_features"])
        labels = [int(any(e["facility"] == facility["id"] and e["category"] == target
                         and e["onset_unix"] <= newest < e["end_unix"] for e in events))
                  for target in contract["output_targets"][:3]]
        labels.append(int(all(s == 0 for s in well_status) and all(w == 0 for w in water)))
        assert labels == vector["targets"]
        print(f"PASS {vector['name']}: 1,152 features, 2,304 bytes, target={labels}")


if __name__ == "__main__":
    main()
