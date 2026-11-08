"""Offline training labels. NEVER imported by encode / features_int / model_int (runtime code).

Per record (facility, newest timestamp):
  pipeline_leak, pump_degradation, pump_failure: 1 when onset_unix <= ts < end_unix for that facility's event
  facility_shut_in: derived from the readings: every configured well has status 0 and water 0
The answer key is used here only to evaluate and fit; it is never a runtime input (global_plan.md hard rule 1).
"""
import json
from pathlib import Path

import numpy as np

from . import wire

EVENT_HEADS = {"pipeline_leak": 0, "pump_degradation": 1, "pump_failure": 2}


def make_labels(records, facilities, answer_key_path):
    events = json.loads(Path(answer_key_path).read_text())
    by_name = {f.id: f.fac_id for f in facilities}
    fac = records["fac_id"].astype(np.int64)
    ts = records["ts_unix"].astype(np.int64)
    Y = np.zeros((len(records), 4), dtype=np.int64)
    event_id = np.full((len(records), 3), "", dtype=object)
    for e in events:
        h = EVENT_HEADS.get(e["category"])
        if h is None or e["facility"] not in by_name:
            continue
        end = e["end_unix"] if e.get("end_unix") is not None else np.iinfo(np.int64).max
        m = (fac == by_name[e["facility"]]) & (ts >= e["onset_unix"]) & (ts < end)
        Y[m, h] = 1
        event_id[m, h] = e["id"]
    nw = {f.fac_id: f.W for f in facilities}
    for i, r in enumerate(records):
        W = nw[int(r["fac_id"])]
        ws = int(r["well_status"])
        if all((ws >> (2 * s) & 3) == 0 and int(r["well_water"][s]) == 0 for s in range(W)):
            Y[i, 3] = 1
    return Y, event_id, events
