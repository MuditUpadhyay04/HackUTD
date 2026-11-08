# SD boot with default weights: change overview for integration agents

- **Status:** decided by Lucas, Sun Nov 8 2026; implementation on branch `eog/T2.sd`. Once merged it lands on `FPGA`.
- **Audience:** every integration agent (board/laptop, server, ingest/replay, ML, web).
- **Why:** after a power cycle the board should classify with a model straight away, without waiting for a PC to push
  WEIGHTS. Until now the board came up with no model (`weights_ver` = 0, zero logits, `NO_MODEL`) until UDP 7004
  delivered a blob.

## Decisions

1. **The board always boots from the microSD card.** JP5 stays on SD. The card holds `BOOT.BIN` (FSBL + bitstream + ARM
   app) and a default weights file.
2. **At boot the ARM loads `weights.eog` from the card into the engine.** It runs the same checks a UDP WEIGHTS COMMIT
   runs, then swaps the model in before it serves any UDP traffic.
3. **The card is read-only for the board.** Weights pushed over UDP 7004 at run time replace the SD weights until the
   next power cycle; they are not written back. To change the boot model, copy a new `weights.eog` onto the card.

## What does NOT change

| Area | Status |
| --- | --- |
| FPGA RTL, engine spec (`FPGA/spec/`), register map | Unchanged. The ARM writes the same 71-word window + `swap_req` that a WEIGHTS commit already uses |
| Wire protocol v1 (C2): ports, packet layouts, ACKs | Unchanged. No new packet types or fields |
| UDP 7004 WEIGHTS path | Unchanged; it stays the live-update path and overrides the SD model at run time |
| Weight blob format (Mudit's `model_int.pack_blob`) | Unchanged. The SD file wraps it (see below) |
| CONFIG handling | Unchanged: **the board still needs GLOBAL CONFIG and Facility CONFIG from the PC before DATA** (DATA before GLOBAL counts as a bad packet). Only the weights are on the card |

## What changes, by consumer

### Server and dashboard
- **Model from boot:** `weights_ver` in STATS (word "active weights version") and `WVER` in every RESULT are non-zero
  from the first record after boot, with no WEIGHTS sent. The value is the SD file's version.
- **Model provenance:** the server can't tell an SD-loaded model from a pushed one by protocol. Use the version number;
  keep SD versions and pushed versions in the same 1–255 space, and don't reuse a number for a different blob.
- **Startup:** still sends HEARTBEAT and receives RESULT/ALERT/STATS exactly as before.
- **Still open, independent of this change:** the server-side acknowledge message (#77).

### Ingest / replay (`hutd_ml.replay`, `hutd_ml.board`, ingest service)
- **Startup order** becomes: *(board boots from SD with the default model)* → GLOBAL CONFIG → Facility CONFIG (ACKed)
  → DATA.
- **Sending WEIGHTS is optional.** If sent, it replaces the SD model (normal ACK/CRC/self-test rules, #67). If the PC
  wants to know what is loaded, read `weights_ver` from STATS before deciding to push.
- `hutd_ml.board --golden …` still pushes the golden set's weights. That's fine: the golden run uses its own model,
  as before.

### ML (Mudit)
- **The SD file needs a wrapper.** The blob carries no version and no CRC (on the wire they travel in the WEIGHTS header
  `aux` and the COMMIT chunk). `weights.eog` is a 16-byte header plus the unchanged blob:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 LE | magic `0x57474F45` (ASCII "EOGW") |
| 4 | u8 | `weights_ver` (1–255; 0 is rejected) |
| 5 | u8 | wrapper format = 1 |
| 6 | u16 LE | blob length in bytes (≤ 1,024) |
| 8 | u32 LE | CRC32 (zlib / IEEE) over the blob bytes only |
| 12 | u32 | reserved = 0 |
| 16 | — | the blob, byte for byte as `pack_blob` produced it |

- **Tool:** `FPGA/deploy/make_weights_sd.py --blob ml/artifacts/v3/weights.bin --version 3 --out weights.eog`. It
  verifies the blob header, the CRC and (if Mudit's `hutd_ml` is importable) `model_int.self_test` before writing.
  `fpga_sync` can call it, or ML can produce the file directly with the same layout.
- **Self-test vectors:** keep the blob's `n_vectors` self-test vectors in it; the board refuses a file whose self-test
  fails.
- **Version numbering:** pick the SD file's `weights_ver` from the same 1–255 sequence as pushed blobs, and never reuse
  a number for a different blob (#50).

### Board / laptop (Vivado, Vitis, deploy)
- **Vivado:** no block-design change; SD0 is already enabled with card detect in `vivado/eclypse_ps7_preset.tcl`.
- **Vitis:**
  - add the `xilffs` (FatFs) library to the BSP, with read-only support enough;
  - create an FSBL application in the platform;
  - `deploy/vitis_build.py` gets the extra library.
- **Boot image:** a new `deploy/make_boot_sd.bat` with a `.bif` runs `bootgen` over the FSBL, the bitstream and
  `eog_app.elf` to make `BOOT.BIN`.
- **Card layout** (FAT32, root directory): `BOOT.BIN` and `weights.eog`.
- **Jumper:** JP5 on SD permanently.
- **Development iterations:** JTAG/xsdb can still download a new bitstream or ELF over a running board for quick
  tests. The SD image is the reference, and every board report must name which one ran.
- **Board acceptance test:**
  1. power-cycle in SD mode;
  2. read STATS: `weights_ver` must equal the file's version before any WEIGHTS packet is sent;
  3. run `hutd_ml.board --golden artifacts/v3/golden/g0` and expect a byte-exact pass.
  Also run the negative cases: missing card, missing file, corrupt CRC.

### FPGA lead (this repo)
- **New task T2.sd:** the ARM SD loader, the wrapper tool, the boot-image scripts and host tests.
- **Docs:** `docs/plan/lucas/fpga_hardware_plan.md` gets an updated startup order and power/boot row, and the
  verification plan's "boot self-test" is defined as this load and self-test (integration updates the plan doc, as in
  #73).

## ARM boot sequence (`FPGA/ps`)

1. Platform and lwIP init (as today). The UDP services are not opened yet.
2. Mount the SD card (FatFs) and read `weights.eog` (≤ 16 + 1,024 B).
3. Check, in this order. On any failure: log the reason on UART and **continue with no model**, so rules, countdown
   and rule-driven alarms still run (today's behaviour).
   1. magic and wrapper format;
   2. version ≠ 0;
   3. length ≤ 1,024 and equal to the file size;
   4. CRC32;
   5. the blob header (`blob_format` 1, `n_heads` 4, `n_features` 31, `feature_set_id` 1);
   6. the self-test vectors.
4. Write blob words 0–69 and word 70 = version into the inactive bank, pulse `swap_req`, and wait for `swap_pending` = 0
   (bounded timeout, logged).
5. Log `SD weights v<N> active`, then open the UDP services. From then on everything is unchanged.

The SD path and the UDP COMMIT path share one function in `eog_proto` (validate, then write the bank and swap), so
both enforce identical checks. The SD and FatFs access sits behind a HAL hook (`hal_read_file`), so host tests cover
every outcome without hardware.

## Failure modes and what consumers see

| Situation | Board behaviour | What the server sees |
| --- | --- | --- |
| No card / no `weights.eog` | Boots (if `BOOT.BIN` came from elsewhere; with SD-only boot there's no boot without a card). No model | `weights_ver` = 0, zero logits, `NO_MODEL` until WEIGHTS arrive |
| File corrupt or failing self-test | Logs on UART; no model | Same as above |
| Valid file | Model active before the first UDP packet | `weights_ver` = file version from the first RESULT |
| WEIGHTS pushed later | Replaces the model (normal path) | New `weights_ver` |
| Power cycle | Back to the SD model | SD version again |

## Open items

- Should GLOBAL/Facility CONFIG also live on the card, so the board needs no PC at all to start classifying? Not in
  scope; it would need ingest to still be the source of truth for slot rules (C3).
- A wire-visible "model source" flag in STATS is not added; the version number identifies the model.
