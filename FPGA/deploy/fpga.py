#!/usr/bin/env python3
"""One-command build / deploy / verify for the Eclypse Z7 — meant to be run by an agent.

    python deploy/fpga.py hw                  # Vivado batch: RTL -> bitstream -> vivado/eclypse_mul.xsa
    python deploy/fpga.py sw                  # Vitis: rebuild the PS app (creates workspace on first run)
    python deploy/fpga.py deploy              # JTAG: program PL, init PS, download + run ELF
    python deploy/fpga.py verify              # UDP smoke test against the running board
    python deploy/fpga.py all                 # hw -> sw -> deploy -> verify
    python deploy/fpga.py pl                  # hw -> deploy -> verify   (RTL-only change: ELF reused)

Every step exits non-zero on failure and prints a one-line RESULT so an agent can branch on it.
Tool paths: auto-detected, or set VIVADO / VITIS / XSDB env vars (full path to the executable).
"""
import argparse
import glob
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
XSA = ROOT / "vivado" / "eclypse_mul.xsa"
WS = ROOT / "vitis_ws"
PLAT, APP = "eclypse_plat", "mul_app"
DOMAIN = "standalone_ps7_cortexa9_0"
WIN = os.name == "nt"

sys.path.insert(0, str(ROOT / "host"))
import proto  # noqa: E402


def result(ok, msg):
    print(f"RESULT: {'PASS' if ok else 'FAIL'} {msg}", flush=True)
    if not ok:
        sys.exit(1)


# ---------------------------------------------------------------- tool discovery
def find_tool(env, names, globs):
    if os.environ.get(env):
        return os.environ[env]
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    hits = []
    for g in globs:
        hits += glob.glob(g)
    if hits:
        return sorted(hits)[-1]          # newest version wins (lexical on version dir)
    return None


def roots():
    if WIN:
        return ["C:/AMDDesignTools/*", "C:/Xilinx", "C:/Xilinx/*", "D:/Xilinx", "D:/Xilinx/*",
                "D:/AMDDesignTools/*"]
    return ["/tools/Xilinx", "/tools/Xilinx/*", "/opt/Xilinx", "/opt/Xilinx/*", "/opt/amd/*",
            os.path.expanduser("~/Xilinx"), os.path.expanduser("~/Xilinx/*")]


def tool(kind):
    ext = ".bat" if WIN else ""
    pats = {
        "vivado": ["Vivado/*/bin/vivado", "*/Vivado/bin/vivado", "Vivado/bin/vivado"],
        "vitis":  ["Vitis/*/bin/vitis", "*/Vitis/bin/vitis", "Vitis/bin/vitis"],
        "xsdb":   ["Vitis/*/bin/xsdb", "*/Vitis/bin/xsdb", "Vitis/bin/xsdb",
                   "Vivado/*/bin/xsdb", "*/Vivado/bin/xsdb", "Vivado/bin/xsdb"],
    }[kind]
    globs = [f"{r}/{p}{ext}" for r in roots() for p in pats]
    t = find_tool(kind.upper(), [kind], globs)
    if not t:
        result(False, f"{kind} not found — set the {kind.upper()} env var to its full path")
    return t


def run(cmd, cwd=None, log=None, timeout=None):
    print("$", " ".join(str(c) for c in cmd), flush=True)
    with open(log, "w") if log else open(os.devnull, "w") as lf:
        p = subprocess.Popen([str(c) for c in cmd], cwd=cwd, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, errors="replace")
        tail = []
        watchdog = threading.Timer(timeout, p.kill) if timeout else None
        if watchdog:
            watchdog.start()
        for line in p.stdout:
            lf.write(line)
            tail = (tail + [line.rstrip()])[-40:]
            if any(k in line for k in ("ERROR", "CRITICAL WARNING", "INFO: worst", "INFO: wrote",
                                       "error:", "Error:")):
                print("  " + line.rstrip(), flush=True)
        rc = p.wait()
        if watchdog:
            watchdog.cancel()
    return rc, tail


# ---------------------------------------------------------------- steps
def step_hw(_):
    t0 = time.time()
    rc, tail = run([tool("vivado"), "-mode", "batch", "-nojournal", "-nolog", "-source", "build.tcl"],
                   cwd=ROOT / "vivado", log=ROOT / "vivado" / "build.log")
    if rc != 0 or not XSA.exists() or not XSA.with_suffix(".bit").exists():
        print("\n".join(tail))
        result(False, f"hw: Vivado exit {rc}; full log vivado/build.log")
    result(True, f"hw: {XSA.name} in {time.time()-t0:.0f}s")


def step_sw(_):
    if not XSA.exists():
        result(False, "sw: no XSA — run `hw` first")
    script = Path(__file__).with_name("vitis_build.py")
    t0 = time.time()
    rc, tail = run([tool("vitis"), "-s", script, str(WS), str(XSA), str(ROOT / "ps" / "udp_mul.c")],
                   cwd=ROOT, log=ROOT / "deploy" / "vitis.log")
    elf = find_elf()
    if rc != 0 or not elf:
        print("\n".join(tail))
        result(False, f"sw: Vitis exit {rc}; full log deploy/vitis.log")
    result(True, f"sw: {elf.relative_to(ROOT)} in {time.time()-t0:.0f}s")


def find_elf():
    hits = [Path(p) for p in glob.glob(str(WS / APP / "build" / "**" / f"{APP}.elf"), recursive=True)]
    hits += [Path(p) for p in glob.glob(str(WS / APP / "**" / "*.elf"), recursive=True)]
    return max(hits, key=lambda p: p.stat().st_mtime) if hits else None


XSDB_TCL = r"""
connect
after 500
puts "targets:"; puts [targets]
targets -set -nocase -filter {{name =~ "APU*"}}
rst -system
after 2000
targets -set -nocase -filter {{name =~ "xc7z*"}}
fpga -file {{{bit}}}
targets -set -nocase -filter {{name =~ "APU*"}}
loadhw -hw {{{xsa}}} -mem-ranges [list {{0x40000000 0xbfffffff}}] -regs
configparams force-mem-access 1
source {{{ps7init}}}
ps7_init
ps7_post_config
targets -set -nocase -filter {{name =~ "*A9*#0"}}
dow {{{elf}}}
configparams force-mem-access 0
con
puts "DEPLOY_OK"
disconnect
"""


def step_deploy(args):
    elf = Path(args.elf) if args.elf else find_elf()
    if not XSA.exists() or not elf or not elf.exists():
        result(False, f"deploy: need {XSA.name} and an ELF (got {elf}) — run `hw` and `sw` first")
    tmp = Path(tempfile.mkdtemp(prefix="fpga_deploy_"))
    with zipfile.ZipFile(XSA) as z:
        z.extractall(tmp)
    bits = list(tmp.rglob("*.bit")) or [p for p in [XSA.with_suffix(".bit")] if p.exists()]
    ps7 = list(tmp.rglob("ps7_init.tcl"))
    if not bits or not ps7:
        result(False, f"deploy: need a .bit (in the XSA or {XSA.with_suffix('.bit').name} beside it) and ps7_init.tcl in the XSA")
    fwd = lambda p: Path(p).resolve().as_posix()   # xsdb wants forward slashes on Windows too
    tcl = tmp / "deploy.tcl"
    tcl.write_text(XSDB_TCL.format(bit=fwd(bits[0]), xsa=fwd(XSA), ps7init=fwd(ps7[0]), elf=fwd(elf)))
    t0 = time.time()
    rc, tail = run([tool("xsdb"), tcl], log=ROOT / "deploy" / "xsdb.log", timeout=180)
    if rc != 0 or not any("DEPLOY_OK" in l for l in tail):
        print("\n".join(tail))
        result(False, "deploy: xsdb failed — board on USB? hw_server/Vivado HW Manager holding the cable?")
    result(True, f"deploy: {bits[0].name} + {elf.name} in {time.time()-t0:.0f}s")


def step_verify(args):
    addr = (args.board_ip, args.board_port)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.3)
    deadline = time.time() + args.wait          # PHY autoneg + lwIP init after `con`
    seq, up = 1, False
    while time.time() < deadline and not up:
        s.sendto(proto.pack_request(seq, 7, 6), addr)
        try:
            data, _ = s.recvfrom(64)
            up = proto.unpack_response(data)["product"] == 42
        except (OSError, ValueError):
            seq += 1
    if not up:
        result(False, f"verify: no valid reply from {addr[0]}:{addr[1]} within {args.wait:.0f}s")
    vec = [(0, 0), (-1, -1), (2**31 - 1, 2**31 - 1), (-2**31, -2**31), (-2**31, 2**31 - 1),
           (123456, -789)] + [(int.from_bytes(os.urandom(4), "big", signed=True),
                               int.from_bytes(os.urandom(4), "big", signed=True)) for _ in range(args.n)]
    bad, rtts = [], []
    for i, (a, b) in enumerate(vec):
        seq += 1
        t0 = time.perf_counter()
        s.sendto(proto.pack_request(seq, a, b), addr)
        try:
            while True:
                r = proto.unpack_response(s.recvfrom(64)[0])
                if r["seq"] == seq:
                    break
            rtts.append((time.perf_counter() - t0) * 1e3)
            if r["status"] != 0 or r["product"] != a * b:
                bad.append((a, b, r["product"], r["status_name"]))
        except (OSError, ValueError) as e:
            bad.append((a, b, None, f"no reply ({e.__class__.__name__})"))
    for b_ in bad[:5]:
        print("  mismatch:", b_)
    rtts.sort()
    med = f"{rtts[len(rtts)//2]:.2f}" if rtts else "n/a"
    result(not bad, f"verify: {len(vec)-len(bad)}/{len(vec)} correct, median RTT {med} ms")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["hw", "sw", "deploy", "verify", "pl", "all"])
    ap.add_argument("--elf", help="ELF to download (default: newest in vitis_ws/mul_app)")
    ap.add_argument("--board-ip", default="192.168.1.10")
    ap.add_argument("--board-port", type=int, default=proto.DEFAULT_PORT)
    ap.add_argument("--wait", type=float, default=20, help="seconds to wait for the board after deploy")
    ap.add_argument("-n", type=int, default=500, help="random vectors in verify")
    args = ap.parse_args()
    plan = {"hw": [step_hw], "sw": [step_sw], "deploy": [step_deploy], "verify": [step_verify],
            "pl": [step_hw, step_deploy, step_verify],
            "all": [step_hw, step_sw, step_deploy, step_verify]}[args.step]
    for f in plan:
        f(args)


if __name__ == "__main__":
    main()
