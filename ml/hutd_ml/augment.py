"""Raw-domain distortions of a dataset (network dict + long telemetry DataFrame), applied BEFORE encoding so they
pass through the real encoder and the bit-exact engine. Used to test (and optionally train for) robustness to a
network that looks different from the practice week. Labels are unchanged: event timing doesn't move.
"""
import copy

import numpy as np

FLOW_METRICS = ("inflow_bpd", "water_bpd", "flow_bpd", "receive_flow_bpd")
PSI_METRICS = ("discharge_psi", "pressure_psi")


def _asset_maps(net):
    p0, q = {}, {}
    for s in net["systems"]:
        for f in s["facilities"]:
            assets = [f["id"], f["tank"]["id"], f["pump"]["id"], f["pipeline"]["id"]] + [w["id"] for w in f["wells"]]
            for a in assets:
                p0[a] = float(s["disposal_site"]["pressure_psi"])
                q[a] = float(f["pump"]["max_flow_bpd"])
    return p0, q


def pressure_offset(factor):
    """Healthy offsets above disposal pressure (+150 / +50 psi in practice) scaled by `factor`."""
    def f(net, tel):
        p0, _ = _asset_maps(net)
        tel = tel.copy()
        m = tel["metric"].isin(PSI_METRICS)
        base = tel.loc[m, "asset_id"].map(p0)
        tel.loc[m, "value"] = base + (tel.loc[m, "value"] - base) * factor
        return net, tel
    return f


def p0_shift(delta):
    """Every disposal site (and every pressure reading) shifted by `delta` psi."""
    def f(net, tel):
        net = copy.deepcopy(net)
        for s in net["systems"]:
            s["disposal_site"]["pressure_psi"] += delta
        tel = tel.copy()
        m = tel["metric"].isin(PSI_METRICS)
        tel.loc[m, "value"] = tel.loc[m, "value"] + delta
        return net, tel
    return f


def scale_size(factor):
    """All flows, well baselines, pump ratings, pipeline ratings and tank capacities scaled together."""
    def f(net, tel):
        net = copy.deepcopy(net)
        for s in net["systems"]:
            for fac in s["facilities"]:
                for w in fac["wells"]:
                    w["baseline_water_bpd"] *= factor
                fac["pump"]["max_flow_bpd"] *= factor
                fac["pipeline"]["max_bpd"] = fac["pipeline"].get("max_bpd", 0) * factor
                fac["tank"]["capacity_bbl"] *= factor
        tel = tel.copy()
        m = tel["metric"].isin(FLOW_METRICS)
        tel.loc[m, "value"] = tel.loc[m, "value"] * factor
        return net, tel
    return f


def noise(seed, flow_frac=0.01, psi=2.0):
    """Extra Gaussian sensor noise: non-zero flows +- flow_frac * pump rating, pressures +- psi."""
    def f(net, tel):
        rng = np.random.default_rng(seed)
        _, q = _asset_maps(net)
        tel = tel.copy()
        m = tel["metric"].isin(FLOW_METRICS) & (tel["value"] != 0)
        tel.loc[m, "value"] = tel.loc[m, "value"] + rng.normal(0, 1, m.sum()) * flow_frac * tel.loc[m, "asset_id"].map(q)
        m = tel["metric"].isin(PSI_METRICS)
        tel.loc[m, "value"] = tel.loc[m, "value"] + rng.normal(0, psi, m.sum())
        return net, tel
    return f


def drop_rows(frac, seed):
    """Randomly delete `frac` of all telemetry rows (exercises HELD / reset / INVALID)."""
    def f(net, tel):
        rng = np.random.default_rng(seed)
        return net, tel[rng.random(len(tel)) >= frac]
    return f


def identity(net, tel):
    return net, tel


# held-out test distortions (never used for training)
TEST = {
    "clean": identity,
    "pressure_x0.7": pressure_offset(0.7),
    "pressure_x1.3": pressure_offset(1.3),
    "p0_+200psi": p0_shift(200),
    "size_x0.5": scale_size(0.5),
    "size_x2": scale_size(2.0),
    "noise": noise(seed=1),
    "drop_2pct": drop_rows(0.02, seed=2),
}
# training augmentations (different factors and seeds from TEST)
TRAIN = {
    "pressure_x0.8": pressure_offset(0.8),
    "pressure_x1.2": pressure_offset(1.2),
    "size_x0.7": scale_size(0.7),
    "size_x1.5": scale_size(1.5),
    "noise_train": noise(seed=99),
}
