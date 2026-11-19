"""test_sd_boot.py — a weights.eog from deploy/make_weights_sd.py, loaded by the C SD boot path (eog_proto.c).

    python FPGA/ps/test/test_sd_boot.py [--ml <dir containing hutd_ml>] [--out <scratch dir>]

The board acceptance test from FPGA/docs/SD_BOOT_WEIGHTS.md, on simboard (C eog_proto + fake eog_regs, Mudit's engine
behind the DATA window) instead of the board:
  1. make_weights_sd.py wraps artifacts/v3/weights.bin as version 3 into a folder standing in for the SD card;
  2. simboard boots from it: the log says "SD weights v3 active" and STATS reports weights_ver 3 before any WEIGHTS;
  3. hutd_ml.board runs golden g0 with the weights.bin removed from a copy of the set (so no WEIGHTS are pushed):
     every RESULT must match byte for byte, WVER included, i.e. the model came from the card;
  4. negative cases: no card, no file, corrupt CRC, version 0, failing self-test -> the reason is logged and STATS
     shows weights_ver 0.
"""
import argparse
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "deploy"))
import make_weights_sd as mws  # noqa: E402
import simboard_bridge as sb  # noqa: E402

STATS_T = 8
WVER_WORD = 12


def first_stats(b, timeout=4.0):
    t = time.monotonic() + timeout
    while time.monotonic() < t:
        with b.lock:
            for _, _, _, pkt in b.sent:
                if pkt[5] == STATS_T:
                    return struct.unpack_from("<16I", pkt, 16)
        time.sleep(0.05)
    return None


def boot(ml, card, udp=False):
    b = sb.SimBoard("127.0.0.2", "127.0.0.1", ml, udp=udp, sd_dir=card)
    st = first_stats(b)
    with b.lock:
        logs = list(b.logs)
    return b, logs, st


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ml", default=None)
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)
    ml = Path(a.ml) if a.ml else sb.default_ml_dir()
    out = Path(a.out or tempfile.mkdtemp(prefix="eog_sdboot_"))
    blob = (ml / "artifacts" / "v3" / "weights.bin").read_bytes()
    fails = 0

    def report(name, ok, detail=""):
        nonlocal fails
        fails += not ok
        print(f"{name}: {'PASS' if ok else 'FAIL'}{' (' + detail + ')' if detail else ''}")

    # 1. the tool
    card = out / "card"
    card.mkdir(parents=True, exist_ok=True)
    rc = mws.main(["--blob", str(ml / "artifacts" / "v3" / "weights.bin"), "--version", "3",
                   "--out", str(card / "weights.eog"), "--ml", str(ml)])
    data = (card / "weights.eog").read_bytes() if rc == 0 else b""
    report("make_weights_sd v3", rc == 0 and len(data) == 16 + len(blob) and data[16:] == blob)

    # 2. boot from it
    b, logs, st = boot(ml, card)
    b.close()
    ok = any(ln.startswith("SD weights v3 active") for ln in logs) and st is not None and st[WVER_WORD] == 3
    report("boot load v3", ok, f"log {logs}, STATS weights_ver {st[WVER_WORD] if st else None}")

    # 3. golden g0 with the model from the card only
    g = out / "g0_no_weights"
    if g.exists():
        shutil.rmtree(g)
    shutil.copytree(ml / "artifacts" / "v3" / "golden" / "g0", g)
    (g / "weights.bin").unlink()
    b = sb.SimBoard("127.0.0.2", "127.0.0.1", ml, sd_dir=card)
    try:
        time.sleep(0.3)
        env = dict(os.environ, PYTHONPATH=str(ml) + os.pathsep + os.environ.get("PYTHONPATH", ""))
        p = subprocess.run([sys.executable, "-m", "hutd_ml.board", "--golden", str(g), "--board", "127.0.0.2",
                            "--local", "127.0.0.1", "--out", str(out / "run_g0"), "--pps", "0", "--wait", "10"],
                           cwd=str(ml), env=env, capture_output=True, text=True, timeout=300)
        lines = [ln for ln in (p.stdout + p.stderr).splitlines() if ln.strip()]
        pushed = sum(1 for _, _, _, pkt in b.sent if pkt[5] == 7)  # WEIGHTS_ACK: none expected
        ok = p.returncode == 0 and lines[-1:] == ["PASS"] and pushed == 0
        report("golden g0 with SD weights only (no WEIGHTS sent)", ok, f"rc {p.returncode}, {pushed} WEIGHTS_ACKs")
        for ln in lines if not ok else [x for x in lines if x.startswith(("CONFIG", "sent", "mismatches"))]:
            print("   ", ln)
    finally:
        b.close()

    # 4. negative cases
    def neg(name, setup, reason):
        d = out / ("neg_" + name.replace(" ", "_"))
        if d.exists():
            shutil.rmtree(d)
        if setup is not None:
            d.mkdir(parents=True)
            setup(d)
        bb, lg, s = boot(ml, d)
        bb.close()
        ok = any(reason in ln for ln in lg) and s is not None and s[WVER_WORD] == 0
        report(f"negative: {name}", ok, f"log {lg}, weights_ver {s[WVER_WORD] if s else None}")

    def write(mod):
        def f(d):
            x = bytearray(data)
            mod(x)
            (d / "weights.eog").write_bytes(bytes(x))
        return f

    def flip_crc(x): x[8] ^= 1
    def ver0(x): x[4] = 0
    def bad_vec(x): x[16 + 280 + 62] ^= 1; struct.pack_into("<I", x, 8, mws.crc32(bytes(x[16:])))
    neg("no card", None, "no card")
    neg("no file", lambda d: None, "not found")
    neg("corrupt CRC", write(flip_crc), "CRC mismatch")
    neg("version 0", write(ver0), "version 0")
    neg("failing self-test", write(bad_vec), "self-test failed")

    print("test_sd_boot:", "FAIL" if fails else "PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
