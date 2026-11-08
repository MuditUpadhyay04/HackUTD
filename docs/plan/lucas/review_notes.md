# FPGA plan — cross-check notes

Checked against: [`fpga_hardware_plan.md`](fpga_hardware_plan.md) (snapshot of the live doc, newest changelog row
Sat 21:20 CST), the challenge reference repo at commit `135ba4c` (`README.md`, `SPEC.md`, `history/full_week/`),
and the Eclypse Z7 / Zynq-7000 public documentation. Written Sat Nov 7, 2026 ~21:45 CST.

These are **review notes, not decisions.** Lucas owns the plan; anything adopted goes into the live doc's
changelog first, then into the repo copy and [`global_plan.md`](../../../global_plan.md).

Reproduce the data checks (the answer key is used for offline evaluation only):

```sh
python3 docs/research/check_fpga_plan.py /path/to/HackUTD-ZeroDay
```

## 1. Findings that need a decision

| # | Severity | Finding | Evidence | Suggested fix | Who decides |
|---|---|---|---|---|---|
| R1 | **High, visible in the demo** | The countdown ring (last 16 values of `inflow − pump flow`) reports **"not filling" for p50 and p90 at every pump-failure onset**, and p50 stays far too long for about 80 min. | In all 13 practice failures the pump was **running** at the step before onset, so the ring is full of negative net-inflow values (≈ B − 1.5B). At onset, p50 and p90 are the sentinel in 13/13 events. At +15 min, p50 is still the sentinel or 100–175 h; at +30 min it is 12–50 h; at +60 min it is 0.9–1.8 h too long. The true time to trip at onset is 3.5–5.6 h. Only p10 (the ring maximum) tracks it. Median \|p50 − `trips_at`\| over the sampled points in the first 80 min where p50 is finite: **1.43 h** with the plan's ring, **0.01 h** with a ring of `inflow_bpd` only. | The SPEC countdown means "hours until shutdown **if nothing changes**", and a failed pump moves 0 bpd. So compute the band from a ring of **facility inflow** (0.5 bpd LSB, already in DATA): p50 = mean, p10 = max, p90 = min, with the same formula. Equivalently, while `pump_fault` is set, use pump flow = 0. The server's fallback band should follow the same rule. RTL cost is the same as now. | Lucas (RTL), Jason (server fallback) |
| R2 | Medium | A **tripped tank** gets the `0xFFFF` "not filling" sentinel, not 0. | 199 practice frames have level ≥ shutdown with inflow 0 (all wells shut in). The formula's numerator is 0 and its net inflow is ≤ 0, so it takes the sentinel branch. Mudit's handoff (section 8) says a tripped tank's countdown is 0. The `rules` bit 2 (level ≥ shutdown) is still set, but the countdown field alone is misleading. | Check `level ≥ shutdown` first → countdown 0 (all three values), then the not-filling check. Add one SymbiYosys property for the ordering. | Lucas |
| R3 | Medium | CONFIG multiplier width: one global shift `S` has to fit both the **u32 field** and **the multiplier you build**. | `sat16((raw·M + 2^(S−1)) >> S)`. The widest multiplier is `M_inv_W = 16384/W · 2^S`; the narrowest is `M_inv_Q`. A single DSP48E1 takes ≤ 24-bit unsigned magnitude in its 25-bit A port. Practice network (W = 3): **S ≤ 11** for one DSP; S ≤ 19 for u32. Unseen network with a 1-well facility: **S ≤ 9** for one DSP; S ≤ 17 for u32. At S = 9 the 1/Q rounding error is up to ≈ 7 feature LSB (at feature 1.0); at S = 11 it is ≈ 2 LSB. Because `features_int.py` copies the arithmetic bit for bit, this is not a train/inference mismatch, only a deviation from the float reference. | Pick S together with the S2 multiplier width (one DSP: S ≤ 9–11; a cascaded 2-DSP multiply: up to 17). Ingest checks every M against that width before sending CONFIG and refuses with a message, as it already does for > 32 facilities or > 8 wells. Optionally compute channel 9 separately (W ≤ 8). | Lucas + Mudit (S is in `features_int.py`) |
| R4 | Policy, needs a sign-off | **E-STOP on a confirmed leak** conflicts with the challenge's leak response and the team's safety framing. | The challenge README and SPEC say a leak gets `field_inspection` ("send an inspector"), not a shutdown. AGENTS.md says FPGA → shutdown is architectural intent, not validated safety control. The handoff says never act directly on unvalidated scores, and the E-STOP trigger includes the leak logit, whose thresholds are not calibrated yet (question 10). | Keep E-STOP as a **latched local alarm signal** (LED/Pmod) that nothing is wired to. The console's recommended action for a leak stays `field_inspection`. Label E-STOP in the UI and the pitch as a hardware alarm demo, not an automatic shutdown. | Lucas + Jason; Gurneal for the UI wording |
| R5 | Low | Weight blob size versus the self-test vectors. | The blob is "about 270 B, so a single chunk", but COMMIT "runs the self-test vectors packed in the blob". One vector (31 int16 features + 4 int16 expected logits) is 70 B, so at most ~10 vectors keep the blob inside one 1,024 B chunk. | Fix the vector count and layout together with the byte order (question 11). | Lucas + Mudit |
| R6 | Low | The "about 40 min" and "about 5.3 h" moving-average time constants count **running** records only. | The averages update only while the pump runs. Practice pumps run 66.6% of frames (stopped 30.3%, faulted 3.1%), so the wall-clock spans are about **1 h** and **8 h**. | Note for Mudit's feature validation (question 14); no RTL change. | Mudit |
| R7 | Medium, only if the judging data has gaps | The hold/reset rule wipes memory too often when readings go missing at random. | Measured with `ml/hutd_ml/robustness.py`: with 2 % of telemetry rows deleted, 22 % of records are HELD, and "more than 2 consecutive records with any held field" resets each facility's memory about **2.7 times per facility-day**. Half of all results then rest on < 64 steps of memory, and leak / degradation average precision drops from 0.97 / 0.94 to 0.83 / 0.73. | Count holds **per field**, not per record. When one field exceeds `hold_max`, mark that field missing (record INVALID) but **don't wipe the memory features**; reset memory only on a real time gap (> `hold_max` missing steps). `features_int.py` will mirror whatever is chosen (assumption A6). | Lucas |

## 2. Verified, no action needed

| Claim in the plan | Check | Result |
|---|---|---|
| Packet layouts: header 16 B, DATA 48 B, Facility CONFIG 64 B, GLOBAL CONFIG 32 B, RESULT 32 B, ALERT 16 B, STATS 64 B | Summed field offsets and widths | All consistent; no overlaps or gaps |
| 30 DATA / 45 RESULT records per 1,472 B payload | 16 + 30·48 = 1,456; 16 + 45·32 = 1,456 | ✓ |
| Magic `0x46474F45` = "EOGF" in bytes | Little-endian bytes 45 4F 47 46 | ✓ |
| 2.44 M records/s; practice week ≈ 12 ms; 41 cycles/record at 100 MHz | 81.3 k packets/s × 30; 30,240 / 2.44 M; 100 M / 2.44 M | ✓ |
| ≈ 140 MACs/record, 0.34 GMAC/s | 4 × 31 head MACs + 12 feature multiplies = 136 | ✓ |
| 16 cycles/record → 6.25 M records/s, 2.6× link | 100 MHz / 16; 6.25 / 2.44 = 2.56 | ✓ |
| 8 DSPs for the head | 124 MACs / 16 cycles = 7.75 per cycle | ✓ |
| 48-bit accumulator never overflows (< 2^36) | 31 · 2^30 + 2^31 < 2^35.1 | ✓ (large margin) |
| Weight blob ≈ 270 B | 4·31·2 + 4·4 + 1 = 265 B | ✓ (but see R5) |
| 31 features = 12 + 19 memory features | 12 + 5 + 5 + 5 + 1 + 1 + 1 + 1 | ✓ |
| Feature multipliers match the handoff formulas at DATA LSBs | e.g. channel 11: Δraw (0.01 %) · 16384·288·C / (10000·B) | ✓ all four |
| Practice facility counts S1 3, S2 3, S3 2, S4 4, S5 3 | `network.json` | ✓ (15) |
| Observed ranges: flow ≤ 3,662 bpd, psi 905–1,261, level 29.5–92 % | `telemetry.csv` | ✓ (3,662.3; 904.7–1,261.4; 29.5–92.0) |
| DATA headroom 4.5× / 2.6× / 3.5× | 16,383/3,662; 3,276.7/1,261; 327.67/92 | ✓ |
| 0xFFFF minutes ≈ 45 days | 65,535 min = 45.5 days | ✓ |
| 735 M facilities at 2.45 M records/s | 2.45 M × 300 s | ✓ |
| Facility CONFIG table 32 × 64 B at 0x1000–0x17FF | 2,048 B | ✓ |
| Mudit's five int16 packing fixtures still pass against the reference commit | `docs/research/verify_handoff.py` | ✓ 5/5 (useful for channel-formula checks; they are CNN-window fixtures, not streaming vectors) |

## 3. Board and toolchain notes

- **Zynq-7020 resources** in the plan (53,200 LUTs, 106,400 FFs, 140 BRAM36, 220 DSP48E1) agree with AMD/Xilinx
  datasheet listings. The ~630 KB BRAM figure includes parity bits; 560 KB without them.
- **Jumbo frames (the plan's "to confirm"):** UG585 v1.5 §16.1.4, as quoted on the element14/Avnet forum, says the
  Zynq-7000 PS GEM does **not** support jumbo frames. Jumbo frames need a PL AXI Ethernet MAC (XAPP1082), which
  this design does not use. Treat 1,500 B frames as the ceiling, and confirm in the current UG585 if it matters.
- **Toolchain:** Digilent's official Eclypse Z7 materials (Petalinux project, Zmod demos) target **2019.1**. The
  plan already avoids depending on them: it uses Vivado/Vitis 2026.1, bare-metal lwIP and the PS7 preset instead
  of board files. Don't mix in Digilent's 2019.1 Petalinux/BSP flow late in the hackathon.
- **Sampling interval:** the DATA rule hard-codes +300 s per facility step. That matches SPEC ("every 5 minutes")
  and the judging data is specified the same way, so no change is needed.

## Sources

- Challenge reference: https://github.com/nihaal419/HackUTD-ZeroDay (`README.md`, `SPEC.md`, `history/`)
- Eclypse Z7 reference manual: https://reference.digilentinc.com/programmable-logic/eclypse-z7/reference-manual
- Eclypse Z7 OS (Petalinux 2019.1 project): https://github.com/Digilent/Eclypse-Z7-OS
- Zynq-7000 overview (XC7Z020 resources): https://www.digikey.cn/zh/htmldatasheets/production/1099073/0/0/1/zynq-7000-all-programmable-soc-overview.html
- Jumbo frames on the Zynq-7000 GEM (quotes UG585 §16.1.4): https://community.element14.com/products/devtools/avnetboardscommunity/avnetboard-forums/f/software-application-development/33191/jumbo-frame-support
- XAPP1082, PL Ethernet with jumbo frames: https://docs.amd.com/v/u/en-US/xapp1082-zynq-eth
