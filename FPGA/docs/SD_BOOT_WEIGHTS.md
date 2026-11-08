# SD boot with default weights: handoff notes

Change notes for integration agents. Decided by Lucas, Sun Nov 8 2026. Implemented on branch `eog/T2.sd`, which merges
into `FPGA`.

## Summary

- The board always boots from the microSD card (JP5 on SD).
- At boot the ARM loads a default model from the card, so classification runs with a model from the first record.
  Before this change the board ran with no model until a PC pushed WEIGHTS.
- The card is read-only for the board. UDP 7004 WEIGHTS still replaces the model at run time, until the next power
  cycle.
- No change to the RTL, the engine spec, the register map or the wire protocol v1.

## Card contents (FAT32, root directory)

| File | Contents |
| --- | --- |
| `BOOT.BIN` | FSBL + bitstream + `eog_app.elf`, built with `bootgen` (`FPGA/deploy/eog_boot.bif`, `make_boot_sd.bat`) |
| `weights.eog` | The default model: a 16-byte header + Mudit's weight blob |

## `weights.eog` format

The blob itself has no version or CRC field; on the wire those travel in the WEIGHTS header `aux` and the COMMIT
chunk. The file therefore wraps the blob:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 LE | magic `0x57474F45` ("EOGW") |
| 4 | u8 | `weights_ver`, 1–255 (0 is rejected) |
| 5 | u8 | wrapper format = 1 |
| 6 | u16 LE | blob length (≤ 1,024) |
| 8 | u32 LE | CRC32 (zlib / IEEE) over the blob bytes |
| 12 | u32 | reserved, 0 |
| 16 | — | the blob, unchanged (`model_int.pack_blob` layout) |

Generator: `FPGA/deploy/make_weights_sd.py --blob <weights.bin> --version N --out weights.eog`. It checks the blob
header and the CRC, and runs Mudit's `self_test` when `hutd_ml` is importable.

## Board behaviour at boot

- **Load:** after platform and lwIP init, and before any UDP port is opened, the ARM reads `weights.eog`.
- **Checks**, the same ones as a UDP WEIGHTS COMMIT, in this order:
  1. magic and wrapper format;
  2. version ≠ 0;
  3. length matches the file size;
  4. CRC32;
  5. the blob header (`blob_format` 1, `n_heads` 4, `n_features` 31, `feature_set_id` 1);
  6. the self-test vectors.
- **On success:** the model is written to the inactive bank (words 0–69 = blob, word 70 = version) and swapped in.
  UART prints `SD weights v<N> active`.
- **On any failure:** UART logs the reason and the board runs with no model (`weights_ver` 0, zero logits,
  `NO_MODEL`). Rules, countdown and rule-driven alarms still run.
- **Shared code:** the SD path and the UDP COMMIT path share one validation and load function. The UDP WEIGHTS_ACK
  status codes are unchanged (#67: 1 CRC, 2 length, 3 header or self-test, 4 swapped).

## What other parts of the system see

| Area | Effect |
| --- | --- |
| Server, dashboard | STATS "active weights version" and every RESULT's `WVER` are non-zero from the first record, set to the SD file's version, with no WEIGHTS sent. There's no protocol flag for "model came from SD"; the version number identifies the model |
| Ingest, replay | Still must send GLOBAL CONFIG and Facility CONFIG before DATA (the board treats DATA before GLOBAL as a bad packet). Sending WEIGHTS is now optional; if sent, it replaces the SD model as before |
| `hutd_ml.board --golden` | Unaffected: it pushes the golden set's weights, which replace the SD model for that run |
| ML (Mudit) | Default models ship as `weights.eog` (same blob, wrapped). Versions share one 1–255 sequence with pushed blobs; a number must not be reused for a different blob (#50). The blob keeps its self-test vectors, because the board refuses a file whose self-test fails |
| Board build (laptop) | Vivado: none (SD0 with card detect is already in `vivado/eclypse_ps7_preset.tcl`). Vitis: the BSP gains `xilffs` (FatFs); the platform gains an FSBL app (`deploy/vitis_build.py`). Deploy: `BOOT.BIN` via `deploy/make_boot_sd.bat`; JP5 stays on SD. JTAG/xsdb can still load a test bitstream or ELF onto a running board; the SD image is the reference build |
| FPGA RTL, spec, register map, wire protocol | No change |

## Behaviour by situation

| Situation | Model after boot | `weights_ver` |
| --- | --- | --- |
| Valid `weights.eog` | SD model | File version |
| File missing, corrupt, or failing self-test | None | 0 |
| WEIGHTS pushed over UDP later | Pushed model | Pushed version |
| Power cycle | SD model again | File version |

## Unchanged

- The UDP 7004 WEIGHTS path (chunks, ACKs, CRC, swap).
- All packet layouts and ports.
- CONFIG handling.
- Weight blob layout.
- The engine's weight window and swap.

## Open items

- GLOBAL and Facility CONFIG are not on the card. A board without a PC still needs ingest to send CONFIG before it
  classifies.
- There is no write-back: weights pushed over UDP are lost at power-off. To update the boot model, replace
  `weights.eog` on the card.
