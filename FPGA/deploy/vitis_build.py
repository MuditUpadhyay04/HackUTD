# vitis_build.py — run by Vitis' Python CLI:
#   vitis -s vitis_build.py <workspace> <xsa> <udp_mul.c | eog_app.c> [extra sources...]
#
# First run : creates the platform (standalone on ps7_cortexa9_0 + lwIP) and an app from the
#             lwIP Echo Server template, then replaces the template's echo.c with udp_mul.c
#             (same file name, so the template's build list needs no edits).
# Later runs: refreshes the source and rebuilds.
# Also copies ps7_init.tcl and the ELF to <workspace>/out/ for deploy/xsdb_deploy.tcl.
import glob
import os
import re
import shutil
import sys
import traceback

import vitis

ws, xsa, src = (os.path.abspath(a) for a in sys.argv[1:4])
PLAT, APP = "eclypse_plat", "mul_app"
out = os.path.join(ws, "out")


def log(*a):
    print("vitis_build:", *a, flush=True)


client = vitis.create_client()
client.set_workspace(path=ws)   # must be new or a real Vitis workspace (no pre-made dirs)
os.makedirs(out, exist_ok=True)

plat_dir = os.path.join(ws, PLAT)
app_dir = os.path.join(ws, APP)


def find_xpfm():
    hits = glob.glob(os.path.join(plat_dir, "export", "**", "*.xpfm"), recursive=True)
    return hits[0] if hits else None


DOMAIN = "standalone_ps7_cortexa9_0"

if not find_xpfm():
    log("creating platform from", xsa)
    client.create_platform_component(name=PLAT, hw_design=xsa, os="standalone",
                                     cpu="ps7_cortexa9_0")

if not os.path.isdir(app_dir):
    # (Re)configure the app domain with lwIP before creating the app. Safe to repeat.
    plat = client.get_component(name=PLAT)
    dom = plat.get_domain(name=DOMAIN)
    log("client repo methods:", [m for m in dir(client) if "repo" in m.lower()])
    extra = os.environ.get("EXTRA_SW_REPO")
    import inspect
    for m in ("add_embedded_sw_repo", "set_embedded_sw_repo", "rescan_embedded_sw_repo",
              "get_embedded_sw_repo"):
        try:
            log(m, inspect.signature(getattr(client, m)))
        except Exception as e:
            log(m, "sig?", e)
    if extra:
        for call in (lambda: client.add_embedded_sw_repo(path=[extra]),
                     lambda: client.add_embedded_sw_repo(path=extra),
                     lambda: client.add_embedded_sw_repo(level="LOCAL", path=[extra])):
            try:
                call(); log("added sw repo", extra); break
            except Exception as e:
                log("add repo attempt failed:", str(e)[:300])
        for call in (lambda: client.rescan_embedded_sw_repo(),
                     lambda: client.rescan_embedded_sw_repo([extra])):
            try:
                call(); log("rescanned"); break
            except Exception as e:
                log("rescan attempt failed:", str(e)[:300])
    try:
        log("sw repos:", client.get_embedded_sw_repo())
    except Exception as e:
        log("get_embedded_sw_repo failed:", str(e)[:200])
    lib = None
    root = os.path.join(os.environ.get("XILINX_VITIS", r"C:\AMDDesignTools\2026.1\Vitis"),
                        "data", "embeddedsw", "ThirdParty", "sw_services")
    # Vitis 2026.1 on Windows drops its own lwip220 (lwip220.yaml has a UTF-8 BOM and is read
    # as cp1252). EXTRA_SW_REPO points at a BOM-free copy from embeddedsw xilinx_v2026.1.
    cands = []
    if extra:
        cands += [None, os.path.join(extra, "ThirdParty", "sw_services", "lwip220")]
    cands += [os.path.join(root, v) for v in ("lwip220_v1_4",)]
    for ver in cands:
        try:
            if ver is None:
                dom.set_lib(lib_name="lwip220")
            else:
                dom.set_lib(lib_name="lwip220", path=ver)
            lib = "lwip220"
            log("added lwip220 from", ver)
            break
        except Exception as e:
            msg = str(e)
            log("set_lib lwip220", ver, ":", msg[:300])
            if "already" in msg.lower():
                lib = "lwip220"
                break
    if lib is None:
        # 2026.1 rejects set_lib(lwip220) on ps7 here, but the lwip_echo_server template lists
        # lwip220 in depends_libs, so creating the app from the template adds it.
        log("lwIP not added via set_lib; relying on the template's depends_libs")
    if lib:
        plat.build()
        log("platform built")

def configure_for_lwip_template():
    """Set the lib params the lwip_echo_server template validates (from its YAML)."""
    import inspect
    plat = client.get_component(name=PLAT)
    dom = plat.get_domain(name=DOMAIN)
    log("set_config", inspect.signature(dom.set_config))
    want = [("lwip220", "lwip220_dhcp", "true"),
            ("lwip220", "lwip220_lwip_dhcp_does_acd_check", "true"),
            ("lwip220", "lwip220_pbuf_pool_size", "2048"),
            ("lwip220", "lwip220_api_mode", "RAW_API"),
            # the EOG app binds 7000/7003/7004/7001 next to udp_mul's 7777: 5 PCBs > the default 4
            ("lwip220", "lwip220_memp_n_udp_pcb", "8"),
            ("xiltimer", "XILTIMER_en_interval_timer", "true")]
    for lib, param, val in want:
        for call in (lambda: dom.set_config(option="lib", param=param, value=val, lib_name=lib),
                     lambda: dom.set_config(option="lib", param=param, value=val)):
            try:
                call(); log("set", lib, param, "=", val); break
            except Exception as e:
                log("set_config", param, "failed:", str(e)[:250])
    plat.build()
    log("platform rebuilt with lwIP template config")


xpfm = find_xpfm()
log("xpfm:", xpfm)
if not os.path.isdir(app_dir) or os.environ.get("VITIS_RECONFIG"):
    configure_for_lwip_template()

if not os.path.isdir(app_dir):
    created = False
    for tmpl in ("lwip_echo_server", "lwIP Echo Server", "lwip_echo"):
        try:
            client.create_app_component(name=APP, platform=xpfm, domain=DOMAIN,
                                        template=tmpl)
            log("app created from template", tmpl)
            created = True
            break
        except Exception as e:
            log("template", tmpl, "failed:", e)
    if not created:
        try:
            log("available templates:", client.get_template_names())
        except Exception:
            pass
        raise SystemExit("could not create app")

srcs = glob.glob(os.path.join(app_dir, "src", "**", "echo.c"), recursive=True)
if not srcs:
    log("src tree:", [p for p in glob.glob(os.path.join(app_dir, "src", "**"), recursive=True)][:40])
    raise SystemExit("echo.c not found in app src")
shutil.copyfile(src, srcs[0])
log("replaced", srcs[0], "with udp_mul.c contents")
# Extra sources (eog_app.c is a unity build): copied to src/eog_inc/ under header names (X.c -> X_c.h) so a
# template build that globs *.c never compiles them a second time.
extras = [os.path.abspath(a) for a in sys.argv[4:]]
if extras:
    inc = os.path.join(os.path.dirname(srcs[0]), "eog_inc")
    os.makedirs(inc, exist_ok=True)
    for e in extras:
        base, ext = os.path.splitext(os.path.basename(e))
        dst = os.path.join(inc, base + "_c.h" if ext == ".c" else base + ext)
        shutil.copyfile(e, dst)
        log("copied", e, "->", dst)

# Direct PC<->board cable has no DHCP server: the template waits 240 ticks for a lease. Use the static fallback
# (192.168.1.10) immediately, as the hand-patched vws2 main.c did. Idempotent; keeps main.c.orig.
for mainc in glob.glob(os.path.join(os.path.dirname(srcs[0]), "main.c")):
    txt = open(mainc, encoding="utf-8", errors="replace").read()
    new = re.sub(r"dhcp_start\(echo_netif\);\s*\n(\s*)dhcp_timoutcntr\s*=\s*\d+;",
                 r"/* HackUTD: direct cable, no DHCP server -> static fallback IP now. */\n\1dhcp_timoutcntr = 0;", txt)
    if new != txt:
        if not os.path.exists(mainc + ".orig"):
            shutil.copyfile(mainc, mainc + ".orig")
        open(mainc, "w", encoding="utf-8").write(new)
        log("patched DHCP wait in", mainc)
    elif "dhcp_timoutcntr = 0;" in txt:
        log("DHCP wait already patched in", mainc)
    else:
        log("WARNING: DHCP wait pattern not found in", mainc)

comp = client.get_component(name=APP)
try:
    comp.build()
except Exception:
    traceback.print_exc()
    raise SystemExit("app build failed")

elfs = sorted(glob.glob(os.path.join(app_dir, "build", "**", "*.elf"), recursive=True),
              key=os.path.getmtime)
ps7 = [p for p in glob.glob(os.path.join(ws, "**", "ps7_init.tcl"), recursive=True)
       if os.path.dirname(os.path.abspath(p)) != os.path.abspath(out)]
if not elfs:
    raise SystemExit("no ELF produced")
shutil.copyfile(elfs[-1], os.path.join(out, "mul_app.elf"))
if ps7:
    shutil.copyfile(ps7[0], os.path.join(out, "ps7_init.tcl"))
elif not os.path.exists(os.path.join(out, "ps7_init.tcl")):
    raise SystemExit("ps7_init.tcl not found: copy it from a Vivado XSA that contains it into out/")
log("ELF:", elfs[-1])
log("ps7_init:", ps7[0] if ps7 else os.path.join(out, "ps7_init.tcl"))
log("BUILD_OK")
vitis.dispose()
