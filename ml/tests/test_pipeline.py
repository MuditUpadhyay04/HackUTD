"""Tests for the encoder, the bit-exact engine reference and the weight blob.

Dataset-backed tests need HUTD_DATA = path to a dataset folder (e.g. HackUTD-ZeroDay/history/full_week);
they are skipped without it.
"""
import json
import os
from pathlib import Path

import numpy as np
import pytest

from hutd_ml import encode, features_int as fi, golden, model_int, wire

DATA = os.environ.get("HUTD_DATA")
needs_data = pytest.mark.skipif(not DATA, reason="set HUTD_DATA to a dataset folder")
REPO = Path(__file__).resolve().parents[2]


def test_layout_sizes():
    assert wire.HEADER.size == 16
    assert wire.DATA_DTYPE.itemsize == 48
    assert wire.FAC_CONFIG_DTYPE.itemsize == 64
    assert wire.GLOBAL_CONFIG_DTYPE.itemsize == 32
    assert wire.RESULT_DTYPE.itemsize == 32
    assert wire.ALERT_DTYPE.itemsize == 16
    assert wire.STATS.size == 64
    assert wire.HEADER.size + wire.DATA_PER_PACKET * 48 <= wire.UDP_PAYLOAD
    assert wire.HEADER.size + wire.RESULT_PER_PACKET * 32 <= wire.UDP_PAYLOAD
    assert wire.header(1, 0, 0)[:4] == b"EOGF"


def test_mem_format():
    rec = np.zeros(2, dtype=wire.DATA_DTYPE)
    rec["fac_id"] = [1, 2]
    lines = wire.records_to_mem(rec).split()
    assert len(lines) == 12 and lines[0].endswith("0001") and lines[6].endswith("0002")


def test_blob_roundtrip_and_self_test():
    w_q, b_q, s_out = model_int.weights_v0()
    blob = model_int.pack_blob(w_q, b_q, s_out, model_int.edge_vectors(), mhash=123)
    assert len(blob) == 280 + 4 * 70
    m = model_int.unpack_blob(blob)
    assert np.array_equal(m["w_q"], w_q) and np.array_equal(m["b_q"], b_q) and m["s_out"] == s_out
    assert m["model_hash"] == 123 and model_int.self_test(blob)
    bad = bytearray(blob)
    bad[-1] ^= 1
    assert not model_int.self_test(bytes(bad))


def test_quantize_close_to_float():
    rng = np.random.default_rng(0)
    w = rng.normal(0, 5, size=(4, 31))
    b = rng.normal(0, 3, size=4)
    w_q, b_q, s_out, fw = model_int.quantize(w, b)
    X = rng.integers(-20000, 27000, size=(500, 31))
    f = (X / 16384) @ w.T + b
    q = model_int.logits_int(X, w_q, b_q, s_out) / 2 ** model_int.L_OUT
    unsat = np.abs(f) < 120
    assert np.abs(q - f)[unsat].max() < 0.05


@pytest.fixture(scope="module")
def enc():
    return encode.encode_dataset(DATA)


@needs_data
def test_encode_practice(enc):
    n = len(enc.facilities)
    assert len(enc.records) == len(enc.timestamps) * n
    assert np.all(enc.records["fac_id"][:n] == np.arange(n))  # timestep-major
    assert np.all(np.diff(enc.records["ts_unix"][::n].astype(np.int64)) > 0)
    assert enc.stats["records_with_absent_fields"] == 0
    d = encode.decode_record(enc.records[0])
    assert d["fac_id"] == 0 and d["inflow"] is not None


@needs_data
def test_engine_matches_float_formulas(enc):
    """The 12 integer channels stay within a few LSB of the handoff's float formulas."""
    res, stages, _ = fi.run(enc.records[:3000], enc.global_config, enc.facility_config)
    assert np.all(res["status"] == wire.ST_VALID)
    facs = enc.facilities
    worst = 0
    prev = {}
    for r, s in zip(enc.records[:3000], stages):
        f = facs[int(r["fac_id"])]
        v = encode.decode_record(r)
        W = f.W
        flt = [v["inflow"] / f.B, v["pump_flow"] / f.Q, v["receive_flow"] / f.Q,
               (v["pump_flow"] - v["receive_flow"]) / f.Q, v["level"] / 100, (v["discharge"] - f.P0) / 150,
               (v["pipeline"] - f.P0) / 50, float(v["pump_status"] == 1), float(v["pump_status"] == 2),
               sum(x == 1 for x in v["well_status"][:W]) / W, sum(v["well_water"][:W]) / f.B,
               0.0 if f.fac_id not in prev else (v["level"] - prev[f.fac_id]) * f.C * 288 / (100 * f.B)]
        prev[f.fac_id] = v["level"]
        worst = max(worst, max(abs(a - b * 16384) for a, b in zip(s["features"][:12], flt)))
    # bound: 0.5 LSB output rounding + multiplier rounding at S_feat = 11 (rel. <= 1.1e-4 of |x| <= 26,660)
    assert worst <= 3.5, worst


@needs_data
def test_handoff_fixture_latest_frames(enc):
    """Latest-frame channels of Mudit's five int16 fixtures (float path) agree within a few LSB."""
    gv = json.loads((REPO / "docs/research/fixtures/golden_vectors.json").read_text())
    want = {(v["facility"], v["ts_unix"]): v["latest_quantized_features"] for v in gv["vectors"]}
    names = {f.id: f.fac_id for f in enc.facilities}
    keys = {(names[f], t) for f, t in want}
    res, stages, _ = fi.run(enc.records, enc.global_config, enc.facility_config)
    got = {}
    for r, s in zip(enc.records, stages):
        k = (int(r["fac_id"]), int(r["ts_unix"]))
        if k in keys:
            got[k] = s["features"][:12]
    for (fac, t), q in want.items():
        diff = np.abs(np.array(got[(names[fac], t)]) - np.array(q))
        # the fixtures use float readings; the wire carries 0.5 bpd steps, so the 3-well sum (channel 10) can be off
        # by 3 x 0.25 bpd = 0.75 / B * 16384 <= 10 LSB; single readings by <= 4 LSB
        assert diff.max() <= 10 and np.delete(diff, 10).max() <= 4, (fac, t, diff)


@needs_data
def test_edge_case_statuses(enc, tmp_path):
    m = golden.build(DATA, tmp_path, "g2", weights="v0")
    res = np.fromfile(tmp_path / "expected_results.bin", dtype=wire.RESULT_DTYPE)
    st = res["status"].tolist()
    reason = res["reason"].tolist()
    assert st[:5] == [wire.ST_VALID] * 5
    assert st[5] == wire.ST_VALID and st[6] == wire.ST_DROPPED and reason[6] == wire.R_DUPLICATE
    assert st[7] == wire.ST_DROPPED and reason[7] == wire.R_OUT_OF_ORDER
    assert st[8] == wire.ST_HELD and reason[8] & wire.R_GAP_HELD
    assert reason[10] & wire.R_RESET and res["since_reset"][10] == 0
    assert st[12:15] == [wire.ST_HELD, wire.ST_HELD, wire.ST_INVALID] and reason[14] & wire.R_RESET
    assert st[15] == wire.ST_VALID and res["since_reset"][15] == 0
    assert reason[17] & wire.R_ENUM and reason[18] & wire.R_RANGE
    assert st[21] == wire.ST_DROPPED and st[22] == wire.ST_DROPPED
    assert reason[21] == reason[22] == wire.R_UNKNOWN_FACILITY
    assert st[29] == st[30] == wire.ST_DROPPED and reason[29] == reason[30] == wire.R_FRAMING  # before the slot check
    assert st[31] == wire.ST_VALID
    assert all(res["since_reset"][i] == 0 for i in range(len(res)) if st[i] == wire.ST_DROPPED)
    assert m["records"] == len(res)


@needs_data
def test_alarm_latches(enc, tmp_path):
    """Night Shift / E-STOP latch (no acknowledge in goldens): each is raised at most once per facility, every
    CLEARED follows a raise of the same latch type, and alerts within a record follow the agreed order."""
    w_q, b_q, s_out = model_int.weights_v0()
    wts = model_int.to_weights(model_int.pack_blob(w_q, b_q, s_out), 9)
    _, _, alerts = fi.run(enc.records[:6000], enc.global_config, enc.facility_config, wts)
    assert alerts
    order = {wire.A_NIGHT_SHIFT: 0, wire.A_ESTOP: 1, wire.A_CLEARED: 2}
    raised, last = {}, {}
    for a in alerts:
        latch = "es" if a["source"] & wire.SRC_LATCH_ESTOP else "ns"
        key = (a["fac_id"], latch)
        if a["kind"] in (wire.A_NIGHT_SHIFT, wire.A_ESTOP):
            assert key not in raised
            raised[key] = True
        else:
            assert a["kind"] == wire.A_CLEARED and key in raised
        rk = (a["result_no"],)
        rank = order[a["kind"]] * 2 + (latch == "es")
        assert last.get(rk, -1) < rank
        last[rk] = rank


@needs_data
def test_engine_head_equals_vectorized(enc):
    w_q, b_q, s_out = model_int.weights_v0()
    blob = model_int.pack_blob(w_q, b_q, s_out)
    wts = model_int.to_weights(blob, 7)
    res, stages, _ = fi.run(enc.records[:600], enc.global_config, enc.facility_config, wts)
    X, ok = fi.feature_matrix(stages)
    assert np.array_equal(res["logits"][ok], model_int.logits_int(X[ok], w_q, b_q, s_out))
    assert np.all(res["weights_ver"] == 7)


@needs_data
def test_deterministic(enc, tmp_path):
    a = golden.build(DATA, tmp_path / "a", "g0")
    b = golden.build(DATA, tmp_path / "b", "g0")
    assert a["sha256"] == b["sha256"]
