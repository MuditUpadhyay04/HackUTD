"""Write golden vectors to FPGA/tb/vectors/ (format: FPGA/model/README.md, "Vector files").

    python FPGA/model/gen_vectors.py            # everything (needs the practice dataset $EOG_DATA and
                                                # Mudit's branch ml for the golden cases: $EOG_ML, see cases.ml_dir)
    python FPGA/model/gen_vectors.py --no-large # skip the git-ignored per-module *_week / *_g1 files

Every case runs through the whole Engine from reset, so each module's .in.hex is exactly the previous stage's
.out.hex for that case. All files are LF-only and deterministic (seeded).
"""
import argparse
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cases as C  # noqa: E402
from eog_ref import Engine, Regs  # noqa: E402
from layouts import BUS, CFG, D, FPGA, G, RES, AL, N_FAC  # noqa: E402

OUT = os.path.join(FPGA, "tb", "vectors")
STAGES = [("validate", "U", "V"), ("features", "V", "F"), ("memory", "F", "M"), ("countdown", "M", "C"),
          ("head", "C", "L"), ("alarm", "L", "A")]
EVENTS = {"validate": {"touch", "cfg"}, "features": {"cfg"}, "countdown": {"cfg"}, "head": {"wts", "swap"},
          "alarm": {"ack", "hb", "hb_expire"},
          "top": {"touch", "cfg", "wts", "swap", "ack", "hb", "hb_expire"}}
CFG_USERS = {"validate", "features", "countdown", "alarm", "top"}
WTS_USERS = {"head", "top"}
LARGE = {"week", "g1"}  # per-module files of these cases are git-ignored (top_ is committed)

index = []


def write(name, lines, what):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="ascii", newline="\n") as fh:
        for ln in lines:
            fh.write(ln + "\n")
    index.append((name, len(lines), what))


def run_case(case, trace=False):
    e = Engine(trace=trace)
    e.configure(case.glb, case.rows)
    cfg0 = [G.hex(e.glb)] + [CFG.hex(e.rows[s]) for s in range(N_FAC)]
    e.load_weights(case.wts)
    e.swap()
    recs, beats, events, alerts, images = [], [], [], [], []
    for st in case.steps:
        k, i = st[0], len(recs)
        if k in ("rec", "beats"):
            bl = st[1] if k == "beats" else [((st[1] >> (64 * j)) & ((1 << 64) - 1), st[2] and j == 5)
                                              for j in range(6)]
            beats += bl
            outs = e.push_beats(bl)
            assert k == "beats" or len(outs) == 1
            for o in outs:
                o["data"] = st[1] if k == "rec" else None
                alerts += [(len(recs), "rec", a) for a in o["alerts"]]
                recs.append(o)
        elif k == "touch":
            e.touch(st[1])
            events.append((i, "touch", st[1], "0"))
        elif k == "cfg":
            e.write_row(st[1], st[2])
            events.append((i, "cfg", st[1], CFG.hex(e.rows[st[1]])))
        elif k == "wts":
            e.load_weights(st[1])
            images.append(st[1])
            events.append((i, "wts", len(images), "0"))
        elif k == "swap":
            e.swap()
            events.append((i, "swap", 0, "0"))
        elif k == "ack":
            alerts += [(i, "ack", a) for a in e.ack()]
            events.append((i, "ack", 0, "0"))
        elif k == "hb":
            e.heartbeat()
            events.append((i, "hb", 0, "0"))
        elif k == "hb_expire":
            e.hb_expire()
            events.append((i, "hb_expire", 0, "0"))
        else:
            raise ValueError(k)
    assert e.beat == 0, "case ends inside a record"
    return dict(e=e, recs=recs, beats=beats, events=events, alerts=alerts, images=images, cfg0=cfg0)


def emit_case(case, large=True, trace=False):
    r = run_case(case, trace)
    recs = r["recs"]
    n = len(recs)
    big = case.name in LARGE
    mods = ["unpack", "validate", "features", "memory", "countdown", "head", "alarm", "pack"]
    if not big or large:
        write("unpack_%s.in.hex" % case.name, ["%017x" % ((int(bool(l)) << 64) | d) for d, l in r["beats"]],
              "%s: %d beats {s_last, s_data[63:0]}" % (case.name, len(r["beats"])))
        write("unpack_%s.out.hex" % case.name, [BUS["U"].hex(o["bus"]["U"]) for o in recs],
              "%s: bus U per emitted record" % case.name)
        for m, bi, bo in STAGES:
            write("%s_%s.in.hex" % (m, case.name), [BUS[bi].hex(o["bus"][bi]) for o in recs],
                  "%s: bus %s" % (case.name, bi))
            write("%s_%s.out.hex" % (m, case.name), [BUS[bo].hex(o["bus"][bo]) for o in recs],
                  "%s: bus %s" % (case.name, bo))
        write("pack_%s.in.hex" % case.name, [BUS["A"].hex(o["bus"]["A"]) for o in recs], "%s: bus A" % case.name)
        write("pack_%s.out.hex" % case.name, [RES.hex(o["res"]) for o in recs], "%s: RESULT" % case.name)
        write("pack_%s.last.hex" % case.name, ["%x" % int(o["m_last"]) for o in recs],
              "%s: m_last on beat 3 (BATCH=45)" % case.name)
    else:
        mods = []
    if case.top:
        mods.append("top")
        write("top_%s.in.hex" % case.name, [D.hex(o["data"]) for o in recs], "%s: DATA records" % case.name)
        write("top_%s.out.hex" % case.name, [RES.hex(o["res"]) for o in recs], "%s: RESULT records" % case.name)
    for m in mods:
        if m in CFG_USERS:
            write("%s_%s.cfg.hex" % (m, case.name), r["cfg0"], "%s: GLOBAL + 32 CONFIG rows at start" % case.name)
        if m in WTS_USERS:
            write("%s_%s.wts.hex" % (m, case.name), ["%08x" % w for w in case.wts],
                  "%s: weight image active at start" % case.name)
            for k, img in enumerate(r["images"], 1):
                write("%s_%s.wts%d.hex" % (m, case.name, k), ["%08x" % w for w in img],
                      "%s: weight image for event 'wts %d'" % (case.name, k))
        if m in EVENTS:
            ev = [e for e in r["events"] if e[1] in EVENTS[m]]
            write("%s_%s.events.txt" % (m, case.name), ["%d %s %d %s" % e for e in ev],
                  "%s: mid-stream events" % case.name)
        if m in ("alarm", "top"):
            write("%s_%s.al.hex" % (m, case.name), [AL.hex(a) for _i, _s, a in r["alerts"]],
                  "%s: ALERT records in push order" % case.name)
            write("%s_%s.al.txt" % (m, case.name), ["%d %s %s" % (i, s, AL.hex(a)) for i, s, a in r["alerts"]],
                  "%s: ALERTs with their record index and cause" % case.name)
    return r


# ------------------------------------------------------------------------------------------------ helpers
def _sample(lst, k, seed):
    lst = sorted(set(lst))
    if len(lst) <= k:
        return lst
    return random.Random(seed).sample(lst, k)


def gen_mul(feat_pairs, head_pairs):
    rng = random.Random(21)
    # features configuration: AW=20 signed, BW=32 unsigned, p 52 bits
    ca = [0, 1, -1, 2, -2, (1 << 19) - 1, -(1 << 19), 12345, -54321, 65535, -65536]
    cb = [0, 1, 2, (1 << 32) - 1, 1 << 31, (1 << 31) - 1, 214748, 1431656, 4294967, 0xDEADBEEF]
    pairs = [(a, b) for a in ca for b in cb]
    pairs += [(rng.randint(-(1 << 19), (1 << 19) - 1), rng.getrandbits(32)) for _ in range(1000)]
    pairs += _sample(feat_pairs, 1000, 22)
    write("mul_feat.in.hex", ["%013x" % (((b & 0xFFFFFFFF) << 20) | (a & 0xFFFFF)) for a, b in pairs],
          "eog_mul AW=20 A_SIGNED=1, BW=32 B_SIGNED=0: {b[31:0], a[19:0]}")
    write("mul_feat.out.hex", ["%013x" % ((a * b) & ((1 << 52) - 1)) for a, b in pairs], "p[51:0] = a*b")
    # head configuration: AW=16 signed, BW=16 signed, p 32 bits
    c16 = [0, 1, -1, 2, 32767, -32768, -32767, 16384, -16384, 255, -256]
    pairs = [(a, b) for a in c16 for b in c16]
    pairs += [(rng.randint(-32768, 32767), rng.randint(-32768, 32767)) for _ in range(1000)]
    pairs += _sample(head_pairs, 1000, 23)
    write("mul_head.in.hex", ["%08x" % (((b & 0xFFFF) << 16) | (a & 0xFFFF)) for a, b in pairs],
          "eog_mul AW=16 A_SIGNED=1, BW=16 B_SIGNED=1: {b[15:0], a[15:0]}")
    write("mul_head.out.hex", ["%08x" % ((a * b) & 0xFFFFFFFF) for a, b in pairs], "p[31:0] = a*b")


def gen_div(div_pairs):
    rng = random.Random(24)
    NW, DW = 48, 32
    cn = [0, 1, 2, (1 << NW) - 1, 1 << 47, (1 << 32) - 1, 1 << 32, 12345678901, 65535 * 256]
    cd = [0, 1, 2, 3, 255, 256, (1 << DW) - 1, 1 << 31, 1 << 27, 7 * 256]
    pairs = [(a, b) for a in cn for b in cd]
    for _ in range(1000):
        pairs.append((rng.getrandbits(rng.randint(1, NW)), rng.getrandbits(rng.randint(1, DW))))
    pairs += _sample(div_pairs, 1000, 25)

    def qr(a, b):
        if b == 0:
            return (1 << NW) - 1, a & ((1 << DW) - 1)
        return a // b, a % b

    write("div_cd.in.hex", ["%020x" % ((b << NW) | a) for a, b in pairs], "eog_div NW=48 DW=32: {d[31:0], n[47:0]}")
    write("div_cd.out.hex", ["%020x" % ((qr(a, b)[1] << NW) | qr(a, b)[0]) for a, b in pairs],
          "{r[31:0], q[47:0]}; d=0 -> q all ones, r = n[31:0]")


def gen_regs():
    rng = random.Random(26)
    m = Regs()
    ins, outs = [], []

    def wr(addr, data, strb=0xF):
        t = m.write(addr, data, strb)
        ins.append("%016x" % ((1 << 56) | (strb << 52) | (addr << 32) | data))
        outs.append("%010x" % (((1 << 37) | (t << 32)) if t is not None else 0))

    def rd(addr):
        ins.append("%016x" % ((2 << 56) | (addr << 32)))
        outs.append("%010x" % m.read(addr))

    for a in (0x0000, 0x0004, 0x0008):
        rd(a)
    for i in range(8):
        wr(0x10 + 4 * i, rng.getrandbits(32))
    for i in range(8):
        rd(0x10 + 4 * i)
    wr(0x10, 0x05040302, 0x1)      # byte 0 (S) always reads 17
    wr(0x14, 0xA5A5A5A5, 0x6)
    rd(0x10), rd(0x14)
    wr(0x08, 0x1)                  # stream_en: GLOBAL writes ignored
    wr(0x18, 0x12345678)
    rd(0x18), rd(0x08)
    wr(0x08, 0x1 | 0x4 | 0x8 | 0x10)  # W1P heartbeat/swap/ack read back 0
    rd(0x08)
    wr(0x08, 0x21), rd(0x08)
    wr(0x08, 0x0), rd(0x08)
    wr(0x18, 0x12345678), rd(0x18)
    for v in (0x80000000 | 0x3F, 0x00FFFF00, 0x80123456 & 0x80FFFF3F):
        wr(0x60, v), rd(0x60)
    base = lambda f: 0x1000 + 64 * f  # noqa: E731
    for i in range(16):            # slot 0 disabled: every word writable, each write touches
        wr(base(0) + 4 * i, rng.getrandbits(32) & (0xFEFFFFFF if i == 0 else 0xFFFFFFFF))
    for i in range(16):
        rd(base(0) + 4 * i)        # FAC_ID reads back as the slot
    wr(base(0), 0x01030000 | 0x1234)  # enable (FLAGS[0] = 1)
    wr(base(0) + 12, 0xFFFFFFFF)      # ignored while enabled
    wr(base(0), 0x01050000)           # word 0 keeping FLAGS[0] = 1: ignored
    wr(base(0), 0x00060000, 0x7)      # word 0 without byte 3: ignored
    rd(base(0)), rd(base(0) + 12)
    wr(base(0), 0x00000000, 0x8)      # clears FLAGS[0]: accepted
    wr(base(0) + 12, 0x0BADF00D)
    rd(base(0)), rd(base(0) + 12)
    for f in (1, 17, 31):
        for i in range(16):
            wr(base(f) + 4 * i, rng.getrandbits(32))
        wr(base(f), 0x01080000)
        rd(base(f)), rd(base(f) + 60)
    for _ in range(300):
        f = rng.choice((0, 1, 2, 17, 31))
        i = rng.randrange(16)
        if rng.random() < 0.5:
            wr(base(f) + 4 * i, rng.getrandbits(32), rng.randint(0, 15))
        else:
            rd(base(f) + 4 * i)
    for a in (0x0034, 0x0070, 0x0800, 0x1800, 0x3000, 0x8000, 0xFFFC):
        rd(a)
    write("regs_basic.in.hex", ins, "AXI-Lite ops: [63:56] op (1 write, 2 read), [55:52] wstrb, [47:32] addr, "
          "[31:0] wdata")
    write("regs_basic.out.hex", outs, "[31:0] read data (0 for writes), [36:32] touched slot, [37] fac_touch pulse")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--no-large", action="store_true", help="skip the git-ignored per-module *_week, *_g1 files")
    ap.add_argument("--no-golden", action="store_true", help="skip Mudit's golden sets (g0, g1, g2, g0v0, g2v0)")
    ap.add_argument("--ml", help="Mudit's ml/ folder (default $EOG_ML or ml/ml next to this repo)")
    ap.add_argument("--out", help="output directory (default FPGA/tb/vectors)")
    a = ap.parse_args(argv)
    global OUT
    if a.out:
        OUT = a.out
    index.clear()
    os.makedirs(OUT, exist_ok=True)
    for c in C.synthetic_cases():
        emit_case(c)
    practice = C.practice_cases() + ([] if a.no_golden else C.golden_cases(a.ml))
    traced = None
    for c in practice:
        r = emit_case(c, large=not a.no_large, trace=(c.name == "onsets"))
        if c.name == "onsets":
            traced = r["e"]
    gen_mul(traced.mul_feat_log, traced.mul_head_log)
    gen_div(traced.div_log)
    gen_regs()
    descs = {c.name: c.desc for c in C.synthetic_cases() + practice}
    with open(os.path.join(OUT, "INDEX.txt"), "w", encoding="ascii", newline="\n") as fh:
        fh.write("# GENERATED by FPGA/model/gen_vectors.py -- do not edit. Regenerate: python FPGA/model/gen_vectors.py\n")
        fh.write("# Cases\n")
        for k, v in descs.items():
            fh.write("case %-8s %s\n" % (k, v))
        fh.write("# Files: name, lines, contents\n")
        for name, n, what in sorted(index):
            fh.write("%-34s %7d  %s\n" % (name, n, what))
    print("wrote %d files to %s" % (len(index), os.path.normpath(OUT)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
