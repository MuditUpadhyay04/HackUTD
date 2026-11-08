# HackUTD project context

Always read this file before working here and use the key resources below as references. Keep verified context current; distinguish proposed interfaces from implemented behavior.

## Event and key resources

- We are building at **HackUTD 2026: Zero Day, November 7–8, 2026**. The hackathon ends November 8: prioritize the working end-to-end demo over expanding scope.
- Event details and tracks: https://zeroday.hackutd.co/#tracks
- Hackerpack (rules, logistics, challenge resources): https://hackutd-2026.notion.site/HackUTD-2026-Zero-Day-Hackerpack-3b163cec774080bea6c5fb7358a42dac
- **Essential project/challenge reference:** https://github.com/nihaal419/HackUTD-ZeroDay. Always consult it before implementation or architecture decisions. Start with `README.md`, then `SPEC.md` for schemas, equipment behavior, and planning rules; these are external reference files, not files in this checkout.
- Additional architecture thoughts: https://claude.ai/artifact/XyRUpbFJisX48WrbFAYA2H. Content was inaccessible behind a security check when this file was updated; consult it when available rather than assume its contents.
- **Team plans:** `global_plan.md` is the cross-team source of truth: hard rules, architecture, contracts, owners and open questions. Per-owner working plans live in `docs/plan/<owner>/`; solidified decisions are promoted into `global_plan.md` with a changelog row. Check changes against `global_plan.md` §2 (hard rules) and §5 (contracts).
- **FPGA plan (source of truth for the FPGA side):** Lucas's live doc https://claude.ai/artifact/1fzKUqpVAnbrWTYDQkEmEQ, copied into `docs/plan/lucas/fpga_hardware_plan.md`. **Never edit the live doc from automation**; update the repo copy instead. Repo-side cross-check findings are in `docs/plan/lucas/review_notes.md`.

## Domain owners

- **Lucas:** FPGA, using the **Eclypse Z7** development kit.
- **Mudit:** model training; works closely with Lucas because model inference runs on the FPGA, not on the training host.
- **Gurneal (also called Jimmy):** web interface and full stack, with Jason helping.
- **Jason:** primary owner of agents; additional contributors may join.
- Coordinate model/tensor/weight-format changes with Mudit and Lucas, and agent/dashboard API changes with Jason and Gurneal.

## Working architecture

Current architecture and contracts: `global_plan.md` §3–§6 (as of Sat Nov 7, 21:45 CST). The bullets below are the November 7 whiteboard, kept for history, with updates noted.


- Sensor data feeds both the FPGA inference path and the server/agent/dashboard path.
- FPGA → server: alerts. Server/training side → FPGA: retrained weights. Training and deployment are separate from on-device inference. *Update:* the FPGA plan now defines UDP RESULT/ALERT/STATS from the board and a chunked, ACKed WEIGHTS path (UDP 7004) into an inactive bank. The blob byte order is still open.
- The server hosts the agent and dashboard for operator-facing analysis and response recommendations.
- The whiteboard also sketches FPGA → shutdown. This is an architectural intent, **not evidence of implemented or validated industrial safety control**; confirm scope with Lucas and Jason before adding actuation. *Update:* the FPGA plan has a latched E-STOP on LEDs/Pmod for a confirmed leak. Treat it as a local alarm signal only; how it squares with the challenge's leak → inspection rule is open (`global_plan.md` O6).
- `docs/research/FPGA_CLASSIFIER_HANDOFF.md` and `docs/research/model-input-v1.json` are **superseded in part** (Sat Nov 7, 21:10). The CNN, the 96-step window, host-side windowing and the 2,304 B full-window transport were replaced by four logistic regressions on streaming memory features computed on the FPGA from raw 48 B records. Still valid: the 12 channel formulas, the output order, the int16 scale 1/16384, server-side sigmoid/events/planning, and the training/validation rules. Four independent outputs allow failure and observed shut-in together; shut-in is not a fourth independent equipment fault.

## Challenge constraints that affect implementation

- Build an operator console for produced-water facilities: detect pipeline leaks, pump degradation, and pump failures; estimate shutdown time and cost-effective responses where applicable.
- Runtime inputs are only `network.json`, `ops.json`, and `telemetry.csv`. Practice `answer_key.json` is for offline training/evaluation, never runtime detection or planning; do not hardcode asset IDs, event schedules, or practice-network constants.
- Telemetry is sampled every five minutes. Use its last timestamp as replay “now,” not the system clock; the practice recording is in October, not the hackathon weekend.
- Leaks and degradation get inspection recommendations, not shutdown countdowns. Pump failures require a countdown and a response planner; concurrent failures share the **system-wide** truck fleet, so plans cannot allocate trucks independently per facility.
- Recommendations do not rewrite recorded telemetry. Keep intervention effects in a separate what-if simulation; the source recording contains no operator actions.

## Checkout/tooling

- As of November 7, this checkout has research artifacts but no application manifest or established build/lint/test commands. Inspect new executable configuration before choosing a toolchain; do not copy organizer-only commands from the external reference as if they run here.
- The FPGA build and deploy scripts (`vivado/build.tcl`, `deploy\*.bat`, Vitis workspace) live on Lucas's PC, not in this checkout. `docs/research/check_fpga_plan.py <reference-repo>` re-runs the review checks behind `docs/plan/lucas/review_notes.md`.
