# vitis_build.py — run by Vitis' Python CLI:
#   vitis -s vitis_build.py <workspace> <xsa> <udp_mul.c | eog_app.c> [extra sources...]
#
# First run : creates the platform (standalone on ps7_cortexa9_0 + lwIP) and an app from the
#             lwIP Echo Server template, then replaces the template's echo.c with udp_mul.c
#             (same file name, so the template's build list needs no edits).
# Later runs: refreshes the source and rebuilds.
# Also copies ps7_init.tcl and the ELF to <workspace>/out/ for deploy/xsdb_deploy.tcl.
#
# eog build only (src = eog_app.c), for the SD boot image (FPGA/docs/SD_BOOT_WEIGHTS.md):
#   * adds the xilffs (FatFs) library to the BSP domain (SD interface, read-only) and makes sure the app links it;
#   * creates/builds an FSBL (zynq_fsbl) for the platform;
#   * leaves in <workspace>/out/: fsbl.elf, eog.bit (from the XSA), eog_app.elf, for deploy/make_boot_sd.bat.
# The mul build (src = udp_mul.c) is unchanged.
import glob
import os
import re
import shutil
import sys
import traceback
import zipfile

import vitis

ws, xsa, src = (os.path.abspath(a) for a in sys.argv[1:4])
PLAT, APP = "eclypse_plat", "mul_app"
EOG = os.path.basename(src).lower() == "eog_app.c"
FSBL_APP = "eog_fsbl"
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


def add_xilffs():
    """eog build: xilffs (FatFs) in the BSP domain, SD interface, read-only. Idempotent; logs every attempt."""
    plat = client.get_component(name=PLAT)
    dom = plat.get_domain(name=DOMAIN)
    have = False
    try:
        libs = dom.get_libs()
        log("domain libs:", libs)
        have = "xilffs" in str(libs)
    except Exception as e:
        log("get_libs failed:", str(e)[:200])
    if have:
        log("xilffs already in the BSP")
        return
    try:
        dom.set_lib(lib_name="xilffs")
        log("added xilffs")
    except Exception as e:
        msg = str(e)
        log("set_lib xilffs:", msg[:300])
        if "already" not in msg.lower():
            raise SystemExit("could not add xilffs to the BSP (needed for the SD weights load)")
    # fs_interface 1 = SD/eMMC (the default); read_only is enough (the board never writes the card).
    # Parameter names differ between the SDT (XILFFS_*) and the older flow; try both.
    for param, val in (("fs_interface", "1"), ("read_only", "true")):
        for name in ("XILFFS_" + param, param):
            try:
                dom.set_config(option="lib", param=name, value=val, lib_name="xilffs")
                log("set xilffs", name, "=", val)
                break
            except Exception as e:
                log("set_config xilffs", name, "failed:", str(e)[:200])
    plat.build()
    log("platform rebuilt with xilffs")


def app_links_xilffs():
    """Older app components may only link the libraries the domain had when the app was created: add xilffs to
    USER_LINK_LIBRARIES in the app's UserConfig.cmake if that file lists libraries and xilffs is missing."""
    for cfg in glob.glob(os.path.join(app_dir, "src", "UserConfig.cmake")):
        txt = open(cfg, encoding="utf-8", errors="replace").read()
        m = re.search(r"set\(\s*USER_LINK_LIBRARIES\s*([^)]*)\)", txt)
        if not m:
            log("UserConfig.cmake has no USER_LINK_LIBRARIES; relying on the BSP's library list")
            continue
        if "xilffs" in m.group(1):
            continue
        body = m.group(1).strip()
        # names only: the template's CMake adds the -l itself ("-lxilffs" became -l-lxilffs on the laptop)
        body = '"xilffs"' if body in ('""', "") else body + ' "xilffs"'
        txt = txt[:m.start()] + "set(USER_LINK_LIBRARIES " + body + ")" + txt[m.end():]
        open(cfg, "w", encoding="utf-8").write(txt)
        log("added xilffs to USER_LINK_LIBRARIES in", cfg)


def find_fsbl():
    hits = [p for p in glob.glob(os.path.join(ws, "**", "fsbl.elf"), recursive=True)
            + glob.glob(os.path.join(ws, FSBL_APP, "build", "**", "*.elf"), recursive=True)
            if os.path.dirname(os.path.abspath(p)) != os.path.abspath(out)]
    return sorted(hits, key=os.path.getmtime)[-1] if hits else None


def make_fsbl():
    """eog build: an FSBL for BOOT.BIN. Vitis usually builds one with the platform (boot components,
    <plat>/zynq_fsbl/...); otherwise create an FSBL app from the zynq_fsbl template and build it."""
    f = find_fsbl()
    if f is None:
        xp = find_xpfm()
        created = os.path.isdir(os.path.join(ws, FSBL_APP))
        if not created:
            plat = client.get_component(name=PLAT)
            doms = []
            try:
                doms = [d for d in plat.list_domains()] if hasattr(plat, "list_domains") else []
            except Exception as e:
                log("list_domains failed:", str(e)[:200])
            log("platform domains:", doms)
            for dom_name in ("zynq_fsbl", "fsbl_domain", DOMAIN):
                for tmpl in ("zynq_fsbl", "Zynq FSBL"):
                    try:
                        client.create_app_component(name=FSBL_APP, platform=xp, domain=dom_name, template=tmpl)
                        log("FSBL app created from template", tmpl, "on domain", dom_name)
                        created = True
                        break
                    except Exception as e:
                        log("FSBL template", tmpl, "domain", dom_name, "failed:", str(e)[:250])
                if created:
                    break
        if not created:
            raise SystemExit("could not create an FSBL app (template zynq_fsbl); create it in the Vitis GUI as "
                             f"'{FSBL_APP}' and re-run")
        try:
            client.get_component(name=FSBL_APP).build()
        except Exception:
            traceback.print_exc()
            raise SystemExit("FSBL build failed")
        f = find_fsbl()
    if f is None:
        raise SystemExit("no FSBL ELF found after the build")
    shutil.copyfile(f, os.path.join(out, "fsbl.elf"))
    log("FSBL:", f)


def extract_bit():
    """eog build: the bitstream for BOOT.BIN, straight from the XSA (a zip)."""
    with zipfile.ZipFile(xsa) as z:
        bits = [n for n in z.namelist() if n.lower().endswith(".bit")]
        if not bits:
            # build_eog.tcl's in-memory flow writes the .bit next to a bit-less XSA; EOG_BIT points at it
            alt = os.environ.get("EOG_BIT")
            if alt and os.path.isfile(alt):
                shutil.copyfile(alt, os.path.join(out, "eog.bit"))
                log("bitstream:", alt, "->", os.path.join(out, "eog.bit"), "(XSA has none; EOG_BIT)")
                return
            raise SystemExit(f"{xsa} has no bitstream: export the XSA with 'include bitstream' or set EOG_BIT")
        with z.open(bits[0]) as r, open(os.path.join(out, "eog.bit"), "wb") as w:
            shutil.copyfileobj(r, w)
    log("bitstream:", bits[0], "->", os.path.join(out, "eog.bit"))


if EOG:
    add_xilffs()

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

if EOG:
    app_links_xilffs()

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
if EOG:
    shutil.copyfile(elfs[-1], os.path.join(out, "eog_app.elf"))
    extract_bit()
    make_fsbl()
    log("SD boot inputs in", out, ": fsbl.elf eog.bit eog_app.elf (deploy/make_boot_sd.bat)")
log("BUILD_OK")
vitis.dispose()
