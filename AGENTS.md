# HackUTD project context

Always read this file before working here and use the key resources below as references. Keep verified context current; distinguish proposed interfaces from implemented behavior.

## Event and key resources

- We are building at **HackUTD 2026: Zero Day, November 7–8, 2026**. The hackathon ends November 8: prioritize the working end-to-end demo over expanding scope.
- Event details and tracks: https://zeroday.hackutd.co/#tracks
- Hackerpack (rules, logistics, challenge resources): https://hackutd-2026.notion.site/HackUTD-2026-Zero-Day-Hackerpack-3b163cec774080bea6c5fb7358a42dac
- **Essential project/challenge reference:** https://github.com/nihaal419/HackUTD-ZeroDay. Always consult it before implementation or architecture decisions. Start with `README.md`, then `SPEC.md` for schemas, equipment behavior, and planning rules; these are external reference files, not files in this checkout.
- Additional architecture thoughts: https://claude.ai/artifact/XyRUpbFJisX48WrbFAYA2H. Content was inaccessible behind a security check when this file was updated; consult it when available rather than assume its contents.

## Domain owners

- **Lucas:** FPGA, using the **Eclypse Z7** development kit.
- **Mudit:** model training; works closely with Lucas because model inference runs on the FPGA, not on the training host.
- **Gurneal (also called Jimmy):** web interface and full stack, with Jason helping.
- **Jason:** primary owner of agents; additional contributors may join.
- Coordinate model/tensor/weight-format changes with Mudit and Lucas, and agent/dashboard API changes with Jason and Gurneal.

## Working architecture (November 7 whiteboard; proposed)

- Sensor data feeds both the FPGA inference path and the server/agent/dashboard path.
- FPGA → server: alerts. Server/training side → FPGA: retrained weights. Training and deployment are separate from on-device inference; the weight-update protocol is not established yet.
- The server hosts the agent and dashboard for operator-facing analysis and response recommendations.
- The whiteboard also sketches FPGA → shutdown. This is an architectural intent, **not evidence of implemented or validated industrial safety control**; confirm scope with Lucas and Jason before adding actuation.
- Read `docs/research/FPGA_CLASSIFIER_HANDOFF.md` and `docs/research/model-input-v1.json` before model/FPGA integration. They describe a **proposed, untrained** temporal input/output contract; confirm hardware compatibility rather than silently adopting it. Four independent outputs allow failure and observed shut-in together; shut-in is not a fourth independent equipment fault.

## Challenge constraints that affect implementation

- Build an operator console for produced-water facilities: detect pipeline leaks, pump degradation, and pump failures; estimate shutdown time and cost-effective responses where applicable.
- Runtime inputs are only `network.json`, `ops.json`, and `telemetry.csv`. Practice `answer_key.json` is for offline training/evaluation, never runtime detection or planning; do not hardcode asset IDs, event schedules, or practice-network constants.
- Telemetry is sampled every five minutes. Use its last timestamp as replay “now,” not the system clock; the practice recording is in October, not the hackathon weekend.
- Leaks and degradation get inspection recommendations, not shutdown countdowns. Pump failures require a countdown and a response planner; concurrent failures share the **system-wide** truck fleet, so plans cannot allocate trucks independently per facility.
- Recommendations do not rewrite recorded telemetry. Keep intervention effects in a separate what-if simulation; the source recording contains no operator actions.

## Checkout/tooling

- As of November 7, this checkout has research artifacts but no application manifest or established build/lint/test commands. Inspect new executable configuration before choosing a toolchain; do not copy organizer-only commands from the external reference as if they run here.
