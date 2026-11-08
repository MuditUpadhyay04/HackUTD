# Offline DATA encoder and hardware prerequisites

`bun apps/encoder/index.ts DATASET_FOLDER > records.bin` reads only network.json,
ops.json and telemetry.csv, using the API dataset importer. Output consists of
48-byte DATA records in timestep/slot order, **not UDP packets**. It computes no
features or decisions and does not contact hardware. Unrepresentable sensor
values are marked absent; invalid timestamps and topology fail the export.

There is intentionally no DATA sender, CONFIG sender, ACK handler or WEIGHTS
uploader yet. Do not send these records to the board until an operator has
confirmed the v1 draft and board build, configured GLOBAL then each facility
with matching ACKs, and either explicitly confirmed an already configured board
or confirmed rules-only version 0. Weights byte order remains open. No actual
board behavior has been verified by this code.

The separate bridge is launched explicitly with `bun apps/api/src/bridge.ts`.
Set BOARD_IP, RUN_ID, BOARD_EPOCH_ID, BOARD_SLOTS (comma-separated), API_URL,
and API_TOKEN. Optional KNOWN_WEIGHTS lists known versions. A version is not
considered known merely because it is zero. Its bounded queue is memory-only;
overflow permanently stops heartbeats until restart, and a crash loses queued
packets. An epoch is an operator assertion: v1 has no epoch on the wire, so
isolate/drain the board before changing runs; delayed packets cannot be proven
to belong to a particular epoch. UDP itself can lose packets before receipt.
