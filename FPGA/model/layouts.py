"""Bit layouts for the EOG engine, taken from the single source in FPGA/spec/gen/.

- Inter-stage buses (U, V, F, M, C, L, A): imported from spec/gen/buses.py.
- Wire records (DATA, CFG, G, RES, AL): the TABLES literal in spec/gen/gendefs.py. That script writes files when it
  runs, so it is parsed with `ast` instead of imported. No offset is retyped here.

A record or bus is handled as one Python int (bit 0 = LSB). Byte k of a wire record is bits [8k+7:8k], so
`int.from_bytes(b, "little")` converts.
"""
import ast
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FPGA = os.path.normpath(os.path.join(HERE, ".."))
GEN = os.path.join(FPGA, "spec", "gen")
sys.path.insert(0, GEN)
import buses as _buses  # noqa: E402  (spec/gen/buses.py)

sys.path.pop(0)


def _gendefs_tables():
    src = open(os.path.join(GEN, "gendefs.py"), encoding="utf-8").read()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "TABLES" for t in node.targets):
            return ast.literal_eval(node.value)
    raise RuntimeError("TABLES not found in spec/gen/gendefs.py")


class Layout:
    """Named fields (name -> (lsb, width)) of one flat vector."""

    def __init__(self, name, fields):
        self.name = name
        self.fields = {}
        self.order = []
        end = 0
        for n, off, w in fields:
            assert off == end, (name, n)
            self.fields[n] = (off, w)
            self.order.append(n)
            end = off + w
        self.width = end
        self.hexdigits = (end + 3) // 4

    def off(self, n):
        return self.fields[n][0]

    def w(self, n):
        return self.fields[n][1]

    def get(self, v, n, signed=False):
        off, w = self.fields[n]
        x = (v >> off) & ((1 << w) - 1)
        if signed and x >> (w - 1):
            x -= 1 << w
        return x

    def put(self, v, n, x):
        off, w = self.fields[n]
        m = (1 << w) - 1
        return (v & ~(m << off)) | ((x & m) << off)

    def pack(self, d):
        v = 0
        for n, x in d.items():
            v = self.put(v, n, x)
        return v

    def unpack(self, v, signed=()):
        return {n: self.get(v, n, n in signed) for n in self.order}

    def hex(self, v):
        assert 0 <= v < (1 << self.width), (self.name, v)
        return format(v, "0%dx" % self.hexdigits)


def _bus_layout(name):
    for b, _desc, f in _buses.BUSES:
        if b == name:
            lay, _w = _buses.layout(f)
            return Layout("B" + b, [(n, o, w) for n, w, o, _d in lay])
    raise KeyError(name)


BUS = {b: _bus_layout(b) for b, _d, _f in _buses.BUSES}
BU, BV, BF, BM, BC, BL, BA = (BUS[k] for k in "UVFMCLA")

_T = _gendefs_tables()
REC = {k: Layout(k, f) for k, (_title, f) in _T.items()}
D, CFG, G, RES, AL = (REC[k] for k in ("D", "CFG", "G", "RES", "AL"))

# Field-index conventions stated in comments of eog_defs.svh / numerics.md (no offsets there to import):
# DATA PRESENT bits: 0 inflow, 1 level, 2 pump status, 3 pump flow, 4 discharge, 5 receive flow, 6 pipeline psi,
#                    8+i well status slot i, 16+i well water slot i.
P_INFLOW, P_LEVEL, P_PUMP_ST, P_PUMP_FLOW, P_DIS, P_RECV, P_PIPE = range(7)
P_WELL_ST, P_WELL_WATER = 8, 16
# CONFIG LO/HI index j = the DATA present bit j (spec v4, numerics.md §2; index 2 bounds the pump status).
# (The CONFIG LO/HI comment in eog_defs.svh still shows the v1 order; numerics.md §2 is normative.)
LH_INFLOW, LH_LEVEL, LH_PUMP_ST, LH_PUMP_FLOW, LH_DIS, LH_RECV, LH_PIPE = range(7)


def _parse_defs():
    """localparams of rtl/eog_defs.svh (generated from the same source): name -> int."""
    import re
    out = {}
    pat = re.compile(r"localparam\s+(?:integer|logic\s*\[\d+:\d+\])\s+(EOG_\w+)\s*=\s*(?:(\d+)?'([dhb]))?([0-9A-Fa-f_]+)\s*;")
    for line in open(os.path.join(FPGA, "rtl", "eog_defs.svh"), encoding="utf-8"):
        for m in pat.finditer(line):
            base = {"d": 10, "h": 16, "b": 2, None: 10}[m.group(3)]
            out[m.group(1)] = int(m.group(4).replace("_", ""), base)
    return out


DEFS = _parse_defs()
ST_VALID, ST_HELD, ST_INVALID, ST_DROPPED = (DEFS["EOG_ST_" + n] for n in ("VALID", "HELD", "INVALID", "DROPPED"))
R = {k[len("EOG_R_"):]: v for k, v in DEFS.items() if k.startswith("EOG_R_")}
# Reason bits 11, 13, 14 were dropped in spec v4 section 6 and restored by Lucas's ruling (TASKS spec question #23,
# matching features_int.py @ 8e67750). The generated value wins once eog_defs.svh carries them again.
for _n, _b in (("FIELD_ABSENT", 11), ("NO_MODEL", 13), ("FIELD_LOST", 14)):
    assert R.setdefault(_n, _b) == _b, _n
RULE = {k[len("EOG_RULE_"):]: v for k, v in DEFS.items() if k.startswith("EOG_RULE_")}
AK = {k[len("EOG_AK_"):]: v for k, v in DEFS.items() if k.startswith("EOG_AK_")}
FEAT_SHIFT = DEFS["EOG_FEAT_SHIFT"]
K_LEVEL, K_DIS, K_PIPE = DEFS["EOG_K_LEVEL"], DEFS["EOG_K_DIS"], DEFS["EOG_K_PIPE"]
ONE = DEFS["EOG_ONE"]
EMA_FAST, EMA_SLOW = DEFS["EOG_EMA_FAST"], DEFS["EOG_EMA_SLOW"]
CD_SCALE = DEFS["EOG_CD_SCALE"]
CD_NONE = DEFS["EOG_CD_NONE"]
N_FAC, N_WELL, N_FEAT, N_CLS, CD_N, CD_LOG2, WIN_WORDS = (
    DEFS["EOG_" + n] for n in ("N_FAC", "N_WELL", "N_FEAT", "N_CLS", "CD_N", "CD_LOG2", "WIN_WORDS"))
assert CD_N == 1 << CD_LOG2
SPEC_VERSION = DEFS["EOG_SPEC_VERSION"]


def s16(x):
    x &= 0xFFFF
    return x - 0x10000 if x & 0x8000 else x


def arr_get(v, lay, field, i, ew=16, signed=True):
    """Element i (width ew) of an array field."""
    x = (v >> (lay.off(field) + ew * i)) & ((1 << ew) - 1)
    if signed and x >> (ew - 1):
        x -= 1 << ew
    return x


def arr_pack(vals, ew=16):
    v = 0
    for i, x in enumerate(vals):
        v |= (x & ((1 << ew) - 1)) << (ew * i)
    return v


def arr_unpack(v, n, ew=16, signed=True):
    out = []
    for i in range(n):
        x = (v >> (ew * i)) & ((1 << ew) - 1)
        if signed and x >> (ew - 1):
            x -= 1 << ew
        out.append(x)
    return out
